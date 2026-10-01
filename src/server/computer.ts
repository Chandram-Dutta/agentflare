import { DurableObject } from "cloudflare:workers";
import type {
  Request as WorkerRequest,
  Response as WorkerResponse,
} from "@cloudflare/workers-types";
import { Workspace, type DurableObjectStorageLike } from "@cloudflare/computer";
import {
  CloudflareContainerBackend,
  withWorkspaceContainer,
} from "@cloudflare/computer/backends/container";
import type { Bindings } from "./env";
import type { AcpAction, AcpActivity, AcpSnapshot } from "@/lib/acp";
import {
  shellArgument as q,
  type RuntimeState,
  type PublishInput,
  type BranchReview,
} from "@/lib/runtime";
import type { UserStart } from "./user-runtime";
import { publishSnapshot, type PublishState } from "./publish";
import {
  sealCredentials,
  openCredentials,
  type SealedCredentials,
} from "./codex-credentials";

// Account-scoped authentication, never part of a Computer filesystem or Artifacts repo.
export class ComputerCredentials extends DurableObject<Bindings> {
  async read() {
    const values = await this.ctx.storage.get<number | SealedCredentials>([
      "epoch",
      "credentials",
    ]);
    const epoch = (values.get("epoch") as number | undefined) ?? 0;
    const sealed = values.get("credentials") as SealedCredentials | undefined;
    return {
      epoch,
      value: sealed
        ? await openCredentials(
            this.env.BETTER_AUTH_SECRET!,
            this.ctx.id.toString(),
            sealed,
          )
        : null,
    };
  }
  async write(epoch: number, value: string | null) {
    const sealed =
      value === null
        ? null
        : await sealCredentials(
            this.env.BETTER_AUTH_SECRET!,
            this.ctx.id.toString(),
            value,
          );
    return this.ctx.storage.transaction(async (tx) => {
      if (((await tx.get<number>("epoch")) ?? 0) !== epoch) return null;
      if (sealed) await tx.put("credentials", sealed);
      else if (await tx.get("credentials")) {
        await tx.delete("credentials");
        await tx.put("epoch", epoch + 1);
        return { epoch: epoch + 1 };
      }
      return { epoch };
    });
  }
}

type State = RuntimeState & {
  id: string;
  owner: string;
  baseSha: string;
  baseBranch: string;
};

export class ComputerThread extends withWorkspaceContainer(
  class extends DurableObject<Bindings> {},
) {
  private backend = new CloudflareContainerBackend({
    container: () => this,
    workspace: { binding: "Computers", id: this.ctx.id.toString() },
    id: "linux",
    egress: { mode: "direct" },
    containerEnv: { FUSE_MOUNT: "fuse" },
  });
  private computer = new Workspace({
    storage: this.ctx.storage as unknown as DurableObjectStorageLike,
    sessionId: this.ctx.id.toString(),
    backends: [this.backend],
    artifacts: this.env.ARTIFACTS ? { binding: this.env.ARTIFACTS } : undefined,
  });
  private operations: Promise<unknown> = Promise.resolve();
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.operations.then(work, work);
    this.operations = result.catch(() => {});
    return result;
  }
  __getWorkspaceStub() {
    return Promise.resolve(this.computer.stub());
  }
  fetch(request: WorkerRequest): Promise<WorkerResponse> {
    return this.backend.handleFetch(
      request as unknown as Request,
    ) as unknown as Promise<WorkerResponse>;
  }
  private async exec(command: string, env?: Record<string, string>) {
    const handle = await this.computer.runtime.exec(command, {
      backend: "linux",
      encoding: "utf8",
      env,
      timeoutMs: 120000,
    });
    const result = await handle.result();
    if (result.exitCode !== 0) throw Error("Computer command failed.");
    if (result.sync.status === "pending" || result.skipped.length > 0)
      throw Error(
        "Computer filesystem sync is incomplete. Retry before closing the thread.",
      );
    return result.stdout;
  }
  private async pull() {
    for await (const block of this.computer.pull("linux")) {
      if (block.skipped > 0)
        throw Error(
          "Computer filesystem sync is incomplete. Retry before closing the thread.",
        );
    }
    await this.ctx.storage.put("saved-at", new Date().toISOString());
    await this.ctx.storage.delete("checkpoint-error");
  }
  private async remember(snapshot: AcpSnapshot) {
    const saved = { ...snapshot, permissions: [] };
    delete saved.login;
    const previous = await this.ctx.storage.get<AcpSnapshot>("conversation");
    if (JSON.stringify(previous) !== JSON.stringify(saved)) {
      await this.ctx.storage.put({
        conversation: saved,
        "changed-at": Date.now(),
      });
    }
  }
  private async state(id: string) {
    if (await this.ctx.storage.get("deleted")) throw Error("Thread deleted.");
    const state = await this.ctx.storage.get<State>("state");
    if (!state || state.id !== id) throw Error("Start this thread first.");
    return state;
  }
  async userStatus(id: string): Promise<RuntimeState> {
    const state = await this.ctx.storage.get<State>("state");
    return state?.id === id && !(await this.ctx.storage.get("deleted"))
      ? state
      : { started: false };
  }
  userStart(id: string, input: UserStart & { owner: string }) {
    return this.serial(async () => {
      if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("Invalid thread id.");
      if (await this.ctx.storage.get("deleted")) throw Error("Thread deleted.");
      const previous = await this.ctx.storage.get<State>("state");
      if (previous) {
        if (previous.id !== id || previous.owner !== input.owner)
          throw Error("Thread ownership mismatch.");
        return previous;
      }
      const root = `/workspace/threads/${id}`;
      // A failed clone is disposable until the durable state record is committed.
      await this.exec(
        `mkdir -p ${q(root)} && rm -rf ${q(root + "/repo")} && git -c credential.helper= -c http.extraHeader="Authorization: Basic $CLONE_AUTH" clone -- ${q(input.repository)} ${q(root + "/repo")} && git -C ${q(root + "/repo")} switch -c ${q(input.branch)} && git -C ${q(root + "/repo")} config user.name ${q(input.name)} && git -C ${q(root + "/repo")} config user.email agent@agentflare.invalid`,
        {
          CLONE_AUTH: Buffer.from(
            `x-access-token:${input.cloneToken}`,
          ).toString("base64"),
          GIT_TERMINAL_PROMPT: "0",
        },
      );
      const refs = (
        await this.exec(
          `git -C ${q(root + "/repo")} symbolic-ref --short refs/remotes/origin/HEAD && git -C ${q(root + "/repo")} rev-parse HEAD`,
        )
      )
        .trim()
        .split("\n");
      if (!refs[0]?.startsWith("origin/") || !/^[a-f0-9]{40}$/.test(refs[1]))
        throw Error("Cannot determine repository base.");
      const state: State = {
        id,
        owner: input.owner,
        started: true,
        agent: "codex",
        repository: input.repository,
        baseBranch: refs[0].slice(7),
        baseSha: refs[1],
      };
      await this.ctx.storage.put("state", state);
      await this.ctx.storage.put("last-active", Date.now());
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
      return state;
    });
  }
  private async inspect(
    id: string,
    operation: string,
    path = "",
    staged = false,
  ) {
    const state = await this.state(id);
    const encoded = Buffer.from(
      JSON.stringify({ operation, path, staged, base: state.baseSha }),
    ).toString("base64");
    return JSON.parse(
      await this.exec(
        `node /opt/agentflare/repository.mjs ${q(encoded)} ${q(`/workspace/threads/${id}/repo`)}`,
      ),
    );
  }
  userInspect(
    id: string,
    operation: string,
    path = "",
    staged = false,
  ): Promise<unknown> {
    return this.serial(() => this.inspect(id, operation, path, staged));
  }
  userReview(id: string): Promise<BranchReview> {
    return this.serial(async () => ({
      ...(await this.inspect(id, "review")),
      baseBranch: (await this.state(id)).baseBranch,
      published: (await this.ctx.storage.get<PublishState>("publish"))?.result,
    }));
  }
  userPublish(
    id: string,
    input: PublishInput & { branch: string; token: string },
  ) {
    return this.serial(async () => {
      const state = await this.state(id);
      return publishSnapshot({
        ...input,
        ...state,
        repository: state.repository!,
        snapshot: await this.inspect(id, "snapshot"),
        state: (await this.ctx.storage.get<PublishState>("publish")) ?? {},
        save: (value) => this.ctx.storage.put("publish", value),
      });
    });
  }
  private bridge(path: string, method = "GET", body?: unknown) {
    return this.getWorkspaceContainer().fetchPort(
      8766,
      `http://container${path}`,
      {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
  }
  private async ensureBridge(state: State) {
    if (
      this.ctx.container?.running &&
      (await this.bridge("/health").catch(() => null))?.ok
    )
      return;
    // Wait for the old bridge and its agent to exit before restoring auth or
    // binding another server to its port. A health failure is not proof of exit.
    await this.exec(
      "if test -f /run/agentflare-bridge.pid; then pid=$(cat /run/agentflare-bridge.pid); kill -TERM $pid 2>/dev/null || true; for i in $(seq 1 100); do kill -0 $pid 2>/dev/null || break; sleep 0.1; done; if kill -0 $pid 2>/dev/null; then exit 1; fi; rm -f /run/agentflare-bridge.pid; fi",
    );
    // Pulls already completed in a prior instance live in DO SQLite; exec pushes
    // that filesystem into a replacement container before spawning anything.
    const vault = this.env.ComputerAuth!.get(
      this.env.ComputerAuth!.idFromName(state.owner),
    );
    const credentials = await vault.read();
    // Codex's canonical rollout directories persist; credentials and rebuildable
    // SQLite indexes stay outside the synced filesystem, even after atomic writes.
    await this.exec(
      "mkdir -p /workspace/.codex/sessions /workspace/.codex/archived_sessions /run/codex && chmod 700 /run/codex && ln -sfn /workspace/.codex/sessions /run/codex/sessions && ln -sfn /workspace/.codex/archived_sessions /run/codex/archived_sessions && printf 'cli_auth_credentials_store = \"file\"\\n' > /run/codex/config.toml",
    );
    if ((await this.ctx.storage.get("auth-epoch")) !== credentials.epoch)
      await this.exec("rm -f /run/codex/auth.json");
    if (credentials.value)
      await this.exec(
        'umask 077; test -f /run/codex/auth.json || printf %s "$AUTH" > /run/codex/auth.json',
        {
          AUTH: credentials.value,
        },
      );
    const token = crypto.randomUUID() + crypto.randomUUID();
    await this.ctx.storage.put({
      capability: token,
      "auth-epoch": credentials.epoch,
    });
    // The launcher must finish and drain its pipes. A foreground infinite exec
    // never completes its sync contract. Health, not a persisted PID, owns readiness.
    await this.exec(
      "nohup bun /opt/agentflare/acp/bridge.mjs </dev/null >/run/agentflare-bridge.log 2>&1 & echo $! >/run/agentflare-bridge.pid",
      {
        CODEX_HOME: "/run/codex",
        AGENTFLARE_AUTH_CALLBACK: `${this.env.BETTER_AUTH_URL}/api/computer-auth/${this.ctx.id}`,
        AGENTFLARE_AUTH_CAPABILITY: token,
      },
    );
    for (let i = 0; i < 60; i++) {
      if ((await this.bridge("/health").catch(() => null))?.ok) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw Error("Codex bridge did not become ready.");
  }
  async saveCodexCredentials(token: string, value: string | null) {
    if (
      !token ||
      token !== (await this.ctx.storage.get("capability")) ||
      (await this.ctx.storage.get("deleted"))
    )
      return false;
    const state = await this.ctx.storage.get<State>("state");
    if (!state) return false;
    const result = await this.env
      .ComputerAuth!.get(this.env.ComputerAuth!.idFromName(state.owner))
      .write((await this.ctx.storage.get<number>("auth-epoch"))!, value);
    if (!result) return false;
    await this.ctx.storage.put("auth-epoch", result.epoch);
    return true;
  }
  userAcp(id: string, action?: AcpAction): Promise<AcpSnapshot> {
    return this.serial(async () => {
      const state = await this.state(id);
      await this.ensureBridge(state);
      await this.ctx.storage.put("last-active", Date.now());
      if ((await this.ctx.storage.getAlarm()) === null)
        await this.ctx.storage.setAlarm(Date.now() + 30_000);
      const response = await this.bridge(
        `/acp/${id}`,
        action ? "POST" : "GET",
        action,
      );
      if (!response.ok) throw Error("Codex bridge request failed.");
      const snapshot = (await response.json()) as AcpSnapshot;
      await this.remember(snapshot);
      return { ...snapshot, persistence: await this.persistence() };
    });
  }
  async userSaved(id: string): Promise<AcpSnapshot | null> {
    if (!(await this.userStatus(id)).started) return null;
    const snapshot = await this.ctx.storage.get<AcpSnapshot>("conversation");
    return snapshot
      ? {
          ...snapshot,
          saved: !this.ctx.container?.running,
          interrupted:
            !this.ctx.container?.running &&
            ["running", "configuring", "connecting"].includes(snapshot.status),
          persistence: await this.persistence(),
        }
      : null;
  }
  private async persistence(): Promise<
    NonNullable<AcpSnapshot["persistence"]>
  > {
    const savedAt = await this.ctx.storage.get<string>("saved-at");
    const changedAt = (await this.ctx.storage.get<number>("changed-at")) ?? 0;
    const snapshot = await this.ctx.storage.get<AcpSnapshot>("conversation");
    return {
      state: (await this.ctx.storage.get("checkpoint-error"))
        ? "error"
        : savedAt &&
            Date.parse(savedAt) >= changedAt &&
            (!this.ctx.container?.running ||
              snapshot?.status === "ready" ||
              snapshot?.status === "auth-required")
          ? "saved"
          : "saving",
      savedAt,
    };
  }
  async userActivity(): Promise<Record<string, AcpActivity>> {
    if (!this.ctx.container?.running) return {};
    const response = await this.bridge("/activity");
    return response.ok ? response.json() : {};
  }
  async alarm() {
    await this.serial(async () => {
      if (
        !this.ctx.container?.running ||
        (await this.ctx.storage.get("deleted"))
      )
        return;
      try {
        const state = await this.ctx.storage.get<State>("state");
        if (state && (await this.bridge("/health").catch(() => null))?.ok) {
          const response = await this.bridge(`/acp/${state.id}`);
          if (response.ok) {
            await this.remember((await response.json()) as AcpSnapshot);
          }
        }
        await this.pull();
        const lastActive =
          (await this.ctx.storage.get<number>("last-active")) ?? 0;
        if (Date.now() - lastActive < 120_000) return;
        if (await this.ctx.storage.get("capability")) {
          const stopped = await this.bridge("/quiesce", "POST");
          if (stopped.status !== 204) return; // Busy agent: never interrupt it for a checkpoint.
        }
        await this.pull();
        await this.checkpointArtifact();
        await this.ctx.storage.put("saved-at", new Date().toISOString());
        await this.ctx.storage.delete("checkpoint-error");
        await this.computer.close();
        await this.ctx.container!.destroy();
      } catch {
        await this.ctx.storage.put("checkpoint-error", true);
      } finally {
        if (this.ctx.container?.running)
          await this.ctx.storage.setAlarm(Date.now() + 30_000);
      }
    });
  }
  private async checkpointArtifact() {
    if (!this.env.ARTIFACTS) return;
    const state = (await this.ctx.storage.get<State>("state"))!;
    let repo;
    try {
      repo = await this.computer.artifacts.get("code");
    } catch (error) {
      if ((error as { code?: string }).code !== "NOT_FOUND") throw error;
      repo = await this.computer.artifacts.create("code");
    }
    const { token } = await this.computer.artifacts.createToken(
      "code",
      "write",
      300,
    );
    // Uses a separate index so checkpointing never stages or commits the user's
    // working branch. Only repository files go to Artifacts, never CODEX_HOME.
    const root = `/workspace/threads/${state.id}/repo`;
    const sha = await this.exec(
      `cd ${q(root)} && GIT_INDEX_FILE=/tmp/checkpoint-index git read-tree HEAD && GIT_INDEX_FILE=/tmp/checkpoint-index git add -A && tree=$(GIT_INDEX_FILE=/tmp/checkpoint-index git write-tree) && commit=$(printf 'Agentflare checkpoint\\n' | git commit-tree "$tree" -p HEAD) && git -c credential.helper= -c http.extraHeader="Authorization: Bearer $ARTIFACT_TOKEN" push ${q(repo.remote)} "$commit:refs/heads/checkpoint-${Date.now()}" && printf %s "$commit"`,
      { ARTIFACT_TOKEN: token, GIT_TERMINAL_PROMPT: "0" },
    );
    await this.ctx.storage.put("artifact-checkpoint", sha.trim());
  }
  userDelete(id: string) {
    return this.serial(async () => {
      const state = await this.ctx.storage.get<State>("state");
      if (state && state.id !== id) throw Error("Thread ownership mismatch.");
      await this.ctx.storage.put("deleted", true);
      await this.ctx.storage.deleteAlarm();
      await this.computer.close();
      if (this.ctx.container?.running) await this.ctx.container.destroy();
      if (this.env.ARTIFACTS) await this.computer.artifacts.delete("code");
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.put("deleted", true);
    });
  }
}
