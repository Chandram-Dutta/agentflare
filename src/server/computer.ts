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
import { createSnapshotTransport, readSnapshotUpdate, type SnapshotCursor, type SnapshotUpdate } from "../../sandbox/acp/snapshot-transport.mjs";
import {
  shellArgument as q,
  type RuntimeState,
  type PublishInput,
  type BranchReview,
  type WorkspaceLifecycle,
} from "@/lib/runtime";
import type { UserStart } from "./user-runtime";
import { publishSnapshot, type PublishState } from "./publish";
import {
  sealCredentials,
  openCredentials,
  type SealedCredentials,
} from "./codex-credentials";

declare const FixedLengthStream: new (
  length: number,
) => TransformStream<Uint8Array, Uint8Array>;

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

type Checkpoint = {
  id: string;
  savedAt: string;
  revision: number;
  prefix: string;
  artifact?: string;
  fingerprint?: string;
};
const emptyConversation: AcpSnapshot = {
  status: "disconnected",
  messages: [],
  permissions: [],
};
const busy = (s: AcpSnapshot) =>
  ["running", "connecting", "configuring", "authenticating"].includes(
    s.status,
  ) ||
  s.permissions.length > 0 ||
  Boolean(s.login);

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
  private saving = false;
  private resuming?: Promise<AcpSnapshot>;
  private readTransport = createSnapshotTransport<AcpSnapshot>();
  private bridgeCursor?: SnapshotCursor<AcpSnapshot>;
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
  }
  private async uploadArchive(response: Response, key: string) {
    const header = response.headers.get("content-length");
    const length = header === null ? NaN : Number(header);
    if (
      !response.body ||
      !Number.isSafeInteger(length) ||
      length <= 0 ||
      length > 2 * 1024 ** 3
    ) {
      await response.body?.cancel();
      throw Error("Workspace archive length is invalid.");
    }
    // HTTP headers alone do not give a forwarded stream the length R2 requires.
    // FixedLengthStream also rejects truncated or oversized transfers.
    const stream = new FixedLengthStream(length);
    const abort = new AbortController();
    const piping = response.body.pipeTo(stream.writable, {
      signal: abort.signal,
    });
    try {
      await Promise.all([
        this.env.BACKUP_BUCKET!.put(key, stream.readable as never),
        piping,
      ]);
    } catch (error) {
      abort.abort();
      await piping.catch(() => {});
      throw error;
    }
  }
  private async recordSaveFailure(stage: string, error: unknown) {
    const failure = {
      stage,
      reference: crypto.randomUUID(),
      at: new Date().toISOString(),
    };
    // Raw SDK errors may contain commands, credentials or repository content.
    console.error({
      event: "workspace_checkpoint_failed",
      workspace: this.ctx.id.toString(),
      ...failure,
      errorType: error instanceof TypeError ? "TypeError" : "Error",
    });
    await this.ctx.storage.put("checkpoint-error", failure);
  }
  private prefix() {
    return `computer/${this.ctx.id}/`;
  }
  private async conversation(): Promise<AcpSnapshot> {
    const object = await this.env.BACKUP_BUCKET?.get(
      `${this.prefix()}conversation.json`,
    );
    return object
      ? object.json<AcpSnapshot>()
      : ((await this.ctx.storage.get<AcpSnapshot>("conversation")) ??
          emptyConversation);
  }
  private async remember(snapshot: AcpSnapshot) {
    await this.ctx.storage.put("agent-activity", {
      status: snapshot.status,
      attention: snapshot.permissions.length > 0 || Boolean(snapshot.login),
      turn: snapshot.messages.findLast((m) => m.role === "user")?.id,
      turnCancelled: snapshot.turnCancelled,
    } satisfies AcpActivity);
    const saved = { ...snapshot, permissions: [] };
    delete saved.login;
    const json = JSON.stringify(saved);
    const digest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json)),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    if ((await this.ctx.storage.get("conversation-digest")) !== digest) {
      if (!this.env.BACKUP_BUCKET)
        throw Error("Computer backups are not configured.");
      await this.env.BACKUP_BUCKET.put(
        `${this.prefix()}conversation.json`,
        json,
      );
      await this.ctx.storage.put("conversation-digest", digest);
      await this.dirty();
    }
  }
  private async dirty() {
    await this.ctx.storage.put(
      "revision",
      ((await this.ctx.storage.get<number>("revision")) ?? 0) + 1,
    );
  }
  private async lifecycle(): Promise<WorkspaceLifecycle> {
    const phase = await this.ctx.storage.get<WorkspaceLifecycle>("lifecycle");
    if (this.resuming && phase === "recovering") return "recovering";
    if (!this.ctx.container?.running)
      return phase === "suspended" ? "suspended" : "failed";
    if (phase === "suspending" && this.saving) return phase;
    return phase === "failed" || phase === "recovering" || phase === "starting"
      ? "failed"
      : "running";
  }
  private async requireRunning() {
    if ((await this.lifecycle()) !== "running")
      throw Error("Workspace is stopped. Resume it before continuing.");
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
      ? { ...state, workspace: await this.lifecycle() }
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
      const startedAt = performance.now();
      try {
        await this.ctx.storage.put("lifecycle", "starting");
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
        await this.ctx.storage.put("lifecycle", "running");
        await this.dirty();
        await this.ctx.storage.put("last-active", Date.now());
        await this.ctx.storage.setAlarm(Date.now() + 30_000);
        return state;
      } finally {
        await this.ctx.storage.put(
          "startup-ms",
          Math.round(performance.now() - startedAt),
        );
      }
    });
  }
  private async inspect(
    id: string,
    operation: string,
    path = "",
    staged = false,
    revision?: string,
  ) {
    const state = await this.state(id);
    await this.requireRunning();
    const encoded = Buffer.from(
      JSON.stringify({
        operation,
        path,
        staged,
        base: state.baseSha,
        revision,
      }),
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
    revision?: string,
  ): Promise<unknown> {
    return this.serial(() =>
      this.inspect(id, operation, path, staged, revision),
    );
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
        AGENTFLARE_COMPUTER: "1",
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
    // Reads bypass the mutation/checkpoint queue and never start a container.
    if (!action) return this.readSnapshot(id);
    if (action.type === "connect") {
      if (this.resuming) return this.resuming;
      this.resuming = this.serial(async () => {
        const startedAt = performance.now();
        const state = await this.state(id);
        const previous =
          await this.ctx.storage.get<WorkspaceLifecycle>("lifecycle");
        const restore =
          (await this.ctx.storage.get<boolean>("restore-pending")) ||
          previous === "suspended";
        await this.ctx.storage.put("lifecycle", "recovering");
        try {
          // A failed suspend can leave newer files on a live disk than SQLite.
          // Pull before ensureBridge's exec pushes the synced filesystem back.
          // If that pull fails, keep the disk untouched and recovery retryable.
          if (previous === "failed" && this.ctx.container?.running && !restore)
            await this.pull();
          await this.ensureBridge(state);
          if (restore) {
            const checkpoint =
              await this.ctx.storage.get<Checkpoint>("checkpoint");
            if (!checkpoint) throw Error("Saved workspace restoration failed.");
            await this.ctx.storage.put("restore-pending", true);
            const archive = await this.env.BACKUP_BUCKET!.get(
              `${checkpoint.prefix}/workspace.tar.gz`,
            );
            if (!archive) throw Error("Saved workspace restoration failed.");
            const response = await this.getWorkspaceContainer().fetchPort(
              8766,
              "http://container/workspace-archive",
              { method: "POST", body: archive.body as unknown as BodyInit },
            );
            if (!response.ok)
              throw Error("Saved workspace restoration failed.");
            await this.pull();
            await this.ctx.storage.delete("restore-pending");
          }
          const snapshot = await this.fetchSnapshot(id, action);
          await this.remember(snapshot);
          await this.ctx.storage.put({
            lifecycle: "running",
            connected: true,
            "last-active": Date.now(),
          });
          await this.ctx.storage.setAlarm(Date.now() + 30_000);
          return {
            ...snapshot,
            workspace: "running" as const,
            persistence: await this.persistence(),
          };
        } catch (error) {
          await this.ctx.storage.put("lifecycle", "failed");
          throw error;
        } finally {
          await this.ctx.storage.put(
            "resume-ms",
            Math.round(performance.now() - startedAt),
          );
        }
      }).finally(() => {
        this.resuming = undefined;
      });
      return this.resuming;
    }
    return this.serial(async () => {
      await this.state(id);
      if (action.type === "checkpoint") {
        await this.checkpoint(id, false);
        await this.ctx.storage.put("last-active", Date.now());
        await this.ctx.storage.setAlarm(Date.now() + 30_000);
        return this.readSnapshot(id);
      }
      if (action.type === "suspend") {
        if ((await this.lifecycle()) !== "suspended")
          await this.checkpoint(id, true);
        return this.readSnapshot(id);
      }
      await this.requireRunning();
      // Persist the dirty marker before allowing the agent to change anything.
      await this.dirty();
      await this.ctx.storage.put("last-active", Date.now());
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      const snapshot = await this.fetchSnapshot(id, action);
      await this.remember(snapshot);
      return {
        ...snapshot,
        workspace: await this.lifecycle(),
        persistence: await this.persistence(),
      };
    });
  }
  private async fetchSnapshot(id: string, action?: AcpAction) {
    // Capture the base per request: concurrent reads may finish out of order.
    const base = this.bridgeCursor;
    const response = await this.bridge(
      `/acp/${id}${action ? "" : `?transport=delta${base ? `&revision=${encodeURIComponent(base.revision)}` : ""}`}`,
      action ? "POST" : "GET",
      action,
    );
    if (!response.ok) throw Error("Codex bridge request failed.");
    const payload = await response.json() as AcpSnapshot | SnapshotUpdate<AcpSnapshot>;
    // Legacy images still return a plain snapshot during a rolling upgrade.
    if ("status" in payload) return payload;
    const cursor = readSnapshotUpdate(base, payload);
    if (this.bridgeCursor === base) this.bridgeCursor = cursor;
    return cursor.snapshot;
  }
  async userAcpRead(id: string, revision?: string) {
    return this.readTransport.read(await this.readSnapshot(id), revision);
  }
  private async readSnapshot(id: string): Promise<AcpSnapshot> {
    await this.state(id);
    const workspace = await this.lifecycle();
    const snapshot =
      workspace === "running" &&
      !this.saving &&
      (await this.ctx.storage.get("connected"))
        ? await this.fetchSnapshot(id)
        : await this.conversation();
    const persistence = await this.persistence();
    return {
      ...snapshot,
      workspace,
      saved: workspace === "suspended" && persistence.state === "saved",
      interrupted: workspace === "failed",
      persistence,
      timings: {
        startupMs: await this.ctx.storage.get<number>("startup-ms"),
        resumeMs: await this.ctx.storage.get<number>("resume-ms"),
      },
    };
  }
  async userSaved(id: string): Promise<AcpSnapshot | null> {
    if (!(await this.userStatus(id)).started) return null;
    return this.readSnapshot(id);
  }
  private async persistence(): Promise<
    NonNullable<AcpSnapshot["persistence"]>
  > {
    const checkpoint = await this.ctx.storage.get<Checkpoint>("checkpoint");
    const revision = (await this.ctx.storage.get<number>("revision")) ?? 0;
    const failure =
      await this.ctx.storage.get<
        NonNullable<AcpSnapshot["persistence"]>["failure"]
      >("checkpoint-error");
    const timing = await this.ctx.storage.get<{
      durationMs: number;
      completedAt: string;
      unchanged: boolean;
    }>("save-timing");
    return {
      state: !this.env.BACKUP_BUCKET
        ? "disabled"
        : this.saving
          ? "saving"
          : failure
            ? "error"
            : checkpoint &&
                checkpoint.revision === revision &&
                (await this.lifecycle()) !== "failed"
              ? "saved"
              : "dirty",
      savedAt: checkpoint?.savedAt,
      checkpointId: checkpoint?.id,
      failure,
      durationMs: timing?.durationMs,
      checkedAt: timing?.completedAt,
      unchanged: timing?.unchanged,
    };
  }
  async userActivity(): Promise<Record<string, AcpActivity>> {
    const state = await this.ctx.storage.get<State>("state");
    if (!state || (await this.ctx.storage.get("deleted"))) return {};
    const workspace = await this.lifecycle();
    let activity = (await this.ctx.storage.get<AcpActivity>(
      "agent-activity",
    )) ?? { status: "disconnected", attention: false };
    if (
      workspace === "running" &&
      !this.saving &&
      (await this.ctx.storage.get("connected"))
    ) {
      const response = await this.bridge("/activity");
      if (response.ok)
        activity =
          ((await response.json()) as Record<string, AcpActivity>)[state.id] ??
          activity;
    }
    return {
      [state.id]: {
        ...activity,
        workspace,
        attention: workspace === "failed" || activity.attention,
      },
    };
  }
  async alarm() {
    await this.serial(async () => {
      if (
        !this.ctx.container?.running ||
        (await this.ctx.storage.get("deleted"))
      )
        return;
      let stage = "read-conversation";
      try {
        const state = await this.ctx.storage.get<State>("state");
        if (!state || (await this.lifecycle()) !== "running") return;
        const snapshot = await this.fetchSnapshot(state.id);
        stage = "save-conversation";
        await this.remember(snapshot);
        if (busy(snapshot)) {
          // Incremental recovery only; do not advertise a consistent save while writers run.
          await this.ctx.storage.put("last-work", Date.now());
          stage = "incremental-sync";
          await this.pull();
          return;
        }
        const lastActive = Math.max(
          (await this.ctx.storage.get<number>("last-active")) ?? 0,
          (await this.ctx.storage.get<number>("last-work")) ?? 0,
        );
        stage = "checkpoint";
        await this.checkpoint(state.id, Date.now() - lastActive >= 120_000);
      } catch (error) {
        if (stage !== "checkpoint") await this.recordSaveFailure(stage, error);
      } finally {
        if (this.ctx.container?.running)
          await this.ctx.storage.setAlarm(Date.now() + 30_000);
      }
    });
  }
  private async checkpoint(id: string, suspend: boolean) {
    await this.requireRunning();
    if (!this.env.BACKUP_BUCKET)
      throw Error("Computer backups are not configured.");
    if (await this.ctx.storage.get("restore-pending"))
      throw Error("Saved workspace restoration failed.");
    const snapshot = await this.fetchSnapshot(id);
    if (busy(snapshot))
      throw Error(
        "Agent is busy. Wait for the current operation before saving or suspending.",
      );
    this.saving = true;
    const startedAt = performance.now();
    const prefix = `${this.prefix()}checkpoints/${crypto.randomUUID()}`;
    let committed = false;
    let quiesced = false;
    let unchanged = false;
    let stage = "quiesce";
    try {
      if (suspend) {
        await this.ctx.storage.put("lifecycle", "suspending");
        // A lost response is ambiguous: only an explicit refusal proves it stayed alive.
        quiesced = true;
        const stopped = await this.bridge("/quiesce", "POST");
        if (stopped.status === 409) quiesced = false;
        if (stopped.status !== 204)
          throw Error(
            "Agent is busy. Wait for the current operation before saving or suspending.",
          );
      }
      stage = "save-conversation";
      await this.remember(snapshot);
      stage = "filesystem-sync";
      await this.pull();
      stage = "fingerprint";
      const previous = await this.ctx.storage.get<Checkpoint>("checkpoint");
      const revision = (await this.ctx.storage.get<number>("revision")) ?? 0;
      unchanged =
        previous?.fingerprint === (await this.fingerprint()) &&
        previous.revision === revision;
      if (!unchanged) {
        // Artifact creation writes Git objects. Include those in the archive and
        // its fingerprint, otherwise every next idle check would look changed.
        stage = "artifacts";
        const artifact = await this.checkpointArtifact();
        stage = "fingerprint";
        const fingerprint = await this.fingerprint();
        stage = "create-archive";
        const response = await this.bridge("/workspace-archive");
        if (!response.ok || !response.body)
          throw Error("Workspace archive failed.");
        stage = "upload-archive";
        await this.uploadArchive(response, `${prefix}/workspace.tar.gz`);
        stage = "verify-files";
        if (fingerprint !== (await this.fingerprint()))
          throw Error(
            "Workspace changed while saving. Retry when writers are idle.",
          );
        stage = "save-checkpoint-conversation";
        await this.env.BACKUP_BUCKET.put(
          `${prefix}/conversation.json`,
          JSON.stringify({ ...snapshot, permissions: [], login: undefined }),
        );
        const checkpoint: Checkpoint = {
          id: prefix.split("/").at(-1)!,
          prefix,
          savedAt: new Date().toISOString(),
          revision,
          artifact,
          fingerprint,
        };
        const obsolete = await this.ctx.storage.get<Checkpoint>(
          "previous-checkpoint",
        );
        stage = "commit-checkpoint";
        await this.ctx.storage.put({
          checkpoint,
          ...(previous ? { "previous-checkpoint": previous } : {}),
        });
        if (obsolete)
          await this.env.BACKUP_BUCKET.delete([
            `${obsolete.prefix}/workspace.tar.gz`,
            `${obsolete.prefix}/conversation.json`,
          ]).catch(() => {});
      }
      committed = true;
      await this.ctx.storage.delete("checkpoint-error");
      if (suspend) {
        stage = "stop-container";
        await this.computer.close();
        await this.ctx.container!.destroy();
        await this.ctx.storage.put("lifecycle", "suspended");
        await this.ctx.storage.deleteAlarm();
      }
    } catch (error) {
      await this.recordSaveFailure(stage, error);
      // A failed final save may have stopped Codex. Keep the disk, require explicit recovery.
      if (suspend)
        await this.ctx.storage.put(
          "lifecycle",
          quiesced ? "failed" : "running",
        );
      throw error;
    } finally {
      this.saving = false;
      await this.ctx.storage.put("save-timing", {
        durationMs: Math.round(performance.now() - startedAt),
        completedAt: new Date().toISOString(),
        unchanged,
      });
      if (!committed)
        await this.env.BACKUP_BUCKET.delete([
          `${prefix}/workspace.tar.gz`,
          `${prefix}/conversation.json`,
        ]).catch(() => {});
    }
  }
  private async fingerprint() {
    const response = await this.bridge("/workspace-archive", "HEAD");
    const fingerprint = response.headers.get("X-Workspace-Fingerprint");
    if (!response.ok || !fingerprint || !/^[a-f0-9]{64}$/.test(fingerprint))
      throw Error("Workspace fingerprint is unavailable.");
    return fingerprint;
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
    return sha.trim();
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
      if (this.env.BACKUP_BUCKET) {
        let objects;
        do {
          objects = await this.env.BACKUP_BUCKET.list({
            prefix: this.prefix(),
            limit: 500,
          });
          if (objects.objects.length)
            await this.env.BACKUP_BUCKET.delete(
              objects.objects.map((object) => object.key),
            );
        } while (objects.truncated);
      }
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.put("deleted", true);
    });
  }
}
