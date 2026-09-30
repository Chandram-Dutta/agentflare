import type { Sandbox } from "@cloudflare/sandbox";
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import type { Bindings } from "./env";
import type { AcpAction, AcpSnapshot } from "@/lib/acp";
import {
  shellArgument as quote,
  type RuntimeState,
  type BranchReview,
  type PublishInput,
  type PublishResult,
} from "@/lib/runtime";
import { publishSnapshot, type PublishState } from "./publish";
import {
  openCredentials,
  sealCredentials,
  type SealedCredentials,
} from "./codex-credentials";

type Workspace = RuntimeState & { baseSha: string; baseBranch: string };
export type UserStart = {
  repository: string;
  branch: string;
  name: string;
  cloneToken: string;
};
const processId = "agentflare-user-acp";

export class UserRuntime {
  private starting = new Map<string, Promise<RuntimeState>>();
  private publishing = new Map<string, Promise<PublishResult>>();
  private connecting?: Promise<void>;
  private signingOut = false;
  private authWrites: Promise<unknown> = Promise.resolve();
  constructor(
    private sandbox: Sandbox<Bindings>,
    private storage: DurableObjectStorage,
    private env: Bindings,
    private identity: string,
  ) {}

  private root(id: string) {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        id,
      )
    )
      throw Error("Invalid thread id.");
    return `/workspace/threads/${id}`;
  }
  async status(id: string): Promise<RuntimeState> {
    this.root(id);
    if (await this.storage.get(`deleted:${id}`))
      throw Error("This thread's sandbox has been deleted.");
    return (
      (await this.storage.get<Workspace>(`workspace:${id}`)) ?? {
        started: false,
      }
    );
  }
  private async require(id: string) {
    const state = await this.status(id);
    if (!state.started) throw Error("Start this thread first.");
    if (
      !(
        await this.sandbox.exec(
          `test -d ${quote(`${this.root(id)}/repo/.git`)}`,
        )
      ).success
    )
      throw Error(
        "Sandbox files are no longer available. Create a new thread. Checkpoints are not implemented yet.",
      );
  }
  async start(id: string, input: UserStart): Promise<RuntimeState> {
    if (this.starting.has(id)) return this.starting.get(id)!;
    const pending = (async () => {
      const previous = await this.status(id);
      if (previous.started) {
        await this.require(id);
        return previous;
      }
      const root = this.root(id);
      const repo = `${root}/repo`;
      const result = await this.sandbox.exec(
        `mkdir -p ${quote(root)} && git -c credential.helper= -c http.extraHeader="Authorization: Basic $AGENTFLARE_CLONE_AUTH" clone -- ${quote(input.repository)} ${quote(repo)} && git -C ${quote(repo)} switch -c ${quote(input.branch)} && git -C ${quote(repo)} config user.name ${quote(input.name)} && git -C ${quote(repo)} config user.email agent@agentflare.invalid && git -C ${quote(repo)} symbolic-ref --short refs/remotes/origin/HEAD && git -C ${quote(repo)} merge-base HEAD origin/HEAD`,
        {
          env: {
            AGENTFLARE_CLONE_AUTH: Buffer.from(
              `x-access-token:${input.cloneToken}`,
            ).toString("base64"),
            GIT_TERMINAL_PROMPT: "0",
          },
          timeout: 120000,
        },
      );
      if (!result.success)
        throw Error("Workspace startup failed during checking out repository.");
      const [ref, baseSha] = result.stdout.trim().split("\n").slice(-2);
      if (!ref?.startsWith("origin/") || !/^[a-f0-9]{40}$/.test(baseSha))
        throw Error("Cannot determine the thread's base branch.");
      const state: Workspace = {
        started: true,
        agent: "codex",
        repository: input.repository,
        baseSha,
        baseBranch: ref.slice(7),
      };
      await this.storage.put(`workspace:${id}`, state);
      return state;
    })();
    this.starting.set(id, pending);
    try {
      return await pending;
    } finally {
      this.starting.delete(id);
    }
  }
  async inspect(id: string, operation: string, path = "", staged = false) {
    await this.require(id);
    const state = (await this.storage.get<Workspace>(`workspace:${id}`))!;
    const input = Buffer.from(
      JSON.stringify({ operation, path, staged, base: state.baseSha }),
    ).toString("base64");
    const result = await this.sandbox.exec(
      `node /opt/agentflare/repository.mjs ${quote(input)} ${quote(`${this.root(id)}/repo`)}`,
      { timeout: 15000 },
    );
    if (!result.success) throw Error("Repository operation failed.");
    return JSON.parse(result.stdout);
  }
  async review(id: string): Promise<BranchReview> {
    const review = await this.inspect(id, "review");
    const state = (await this.storage.get<Workspace>(`workspace:${id}`))!;
    return {
      ...review,
      baseBranch: state.baseBranch,
      published: (await this.storage.get<PublishState>(`publish:${id}`))
        ?.result,
    };
  }
  async publish(
    id: string,
    input: PublishInput & { branch: string; token: string },
  ): Promise<PublishResult> {
    if (this.publishing.has(id))
      throw Error("Publishing is already in progress.");
    const pending = (async () => {
      const snapshot = await this.inspect(id, "snapshot");
      const state = (await this.storage.get<Workspace>(`workspace:${id}`))!;
      return publishSnapshot({
        ...input,
        ...state,
        repository: state.repository!,
        snapshot,
        state: (await this.storage.get<PublishState>(`publish:${id}`)) ?? {},
        save: (value) => this.storage.put(`publish:${id}`, value),
      });
    })();
    this.publishing.set(id, pending);
    try {
      return await pending;
    } finally {
      this.publishing.delete(id);
    }
  }
  async delete(id: string) {
    const root = this.root(id);
    await this.storage.put(`deleted:${id}`, true);
    await Promise.allSettled([
      this.starting.get(id),
      this.publishing.get(id),
      this.connecting,
    ]);
    const process = await this.sandbox.getProcess(processId);
    if (process && ["running", "starting"].includes(process.status))
      await this.fetch(id, "DELETE");
    const result = await this.sandbox.exec(`rm -rf -- ${quote(root)}`);
    if (!result.success) throw Error("Workspace cleanup failed.");
    await this.storage.delete([`workspace:${id}`, `publish:${id}`]);
  }

  // Only the private container checkpoint capability may write credentials.
  // Serialize writes with logout/start fencing, including across storage awaits.
  persist(token: string, value: string | null): Promise<boolean> {
    const pending = this.authWrites.then(async () => {
      if (
        !token ||
        token !== (await this.storage.get<string>("auth-capability"))
      )
        return false;
      let sealed: SealedCredentials | undefined;
      if (value !== null) {
        if (value.length > 32768) throw Error("Invalid credentials.");
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw Error("Invalid credentials.");
        sealed = await sealCredentials(
          this.env.BETTER_AUTH_SECRET ?? "",
          this.identity,
          value,
        );
      }
      return this.storage.transaction(async (tx) => {
        if (token !== (await tx.get("auth-capability"))) return false;
        if (sealed) await tx.put("codex-credentials", sealed);
        else await tx.delete("codex-credentials");
        return true;
      });
    });
    this.authWrites = pending.catch(() => {});
    return pending;
  }
  private async connect() {
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      let running = await this.sandbox.getProcess(processId);
      if (await this.storage.get("auth-reset")) {
        if (running && ["starting", "running"].includes(running.status))
          await this.sandbox.killProcess(processId);
        const cleared = await this.sandbox.exec(
          "rm -f /workspace/.codex/auth.json",
        );
        if (!cleared.success) throw Error("Codex sign-out cleanup is pending.");
        await this.storage.delete("auth-reset");
        running = null;
      }
      if (running && ["starting", "running"].includes(running.status)) {
        const health = await this.sandbox.containerFetch(
          "http://127.0.0.1/health",
          {},
          8766,
        );
        if (health.ok) return;
        await this.sandbox.killProcess(processId);
      }
      // Rotate the callback capability before restoring. Late checkpoints from
      // a prior container cannot overwrite this runtime's credential state.
      const capability = crypto.randomUUID() + crypto.randomUUID();
      await this.authWrites;
      await this.storage.put("auth-capability", capability);
      const saved =
        await this.storage.get<SealedCredentials>("codex-credentials");
      await this.sandbox.exec(
        "mkdir -p /workspace/threads /workspace/.codex && chmod 700 /workspace/.codex",
      );
      const localAuth = await this.sandbox.exec(
        "test -f /workspace/.codex/auth.json",
      );
      // A surviving disk can contain a newer rotation than the last checkpoint.
      // Restore only onto a fresh home, never overwrite the current native file.
      if (!localAuth.success && saved)
        await this.sandbox.writeFile(
          "/workspace/.codex/auth.json",
          await openCredentials(
            this.env.BETTER_AUTH_SECRET ?? "",
            this.identity,
            saved,
          ),
        );
      await this.sandbox.exec(
        "test ! -f /workspace/.codex/auth.json || chmod 600 /workspace/.codex/auth.json",
      );
      await this.sandbox.exec(
        "test -f /workspace/.codex/config.toml || printf 'cli_auth_credentials_store = \"file\"\\n' > /workspace/.codex/config.toml",
      );
      await this.sandbox.startProcess("bun /opt/agentflare/acp/bridge.mjs", {
        processId,
        autoCleanup: false,
        env: {
          CODEX_HOME: "/workspace/.codex",
          AGENTFLARE_SHARED_RUNTIME: "1",
          AGENTFLARE_AUTH_CALLBACK: `${this.env.BETTER_AUTH_URL}/api/codex-checkpoint/${this.identity}`,
          AGENTFLARE_AUTH_CAPABILITY: capability,
        },
      });
      for (let i = 0; i < 60; i++) {
        try {
          const response = await this.sandbox.containerFetch(
            "http://127.0.0.1/health",
            {},
            8766,
          );
          if (response.ok) return;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw Error("Codex bridge did not become ready.");
    })();
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }
  async acp(id: string, action?: AcpAction): Promise<AcpSnapshot> {
    if (this.signingOut) throw Error("Codex sign-out is in progress.");
    if (action?.type === "logout") this.signingOut = true;
    try {
      await this.require(id);
      await this.connect();
      await this.status(id);
      const snapshot = await this.fetch(
        id,
        action && action.type !== "connect" ? "POST" : "GET",
        action,
      );
      if (action?.type === "logout") {
        // Native logout succeeded and rejected any busy-session race. Fence late
        // checkpoint requests before clearing durable credentials. The reset flag
        // survives a crash during process/disk cleanup; no old login is restored.
        await this.storage.transaction(async (tx) => {
          await tx.put("auth-capability", `revoked-${crypto.randomUUID()}`);
          await tx.put("auth-reset", true);
          await tx.delete("codex-credentials");
        });
        await this.sandbox.killProcess(processId);
        const cleared = await this.sandbox.exec(
          "rm -f /workspace/.codex/auth.json",
        );
        if (!cleared.success) throw Error("Codex sign-out cleanup is pending.");
        await this.storage.delete("auth-reset");
        snapshot.authPersistence = "saved";
      }
      return { ...snapshot, authScope: "user" };
    } finally {
      if (action?.type === "logout") this.signingOut = false;
    }
  }
  private async fetch(
    id: string,
    method: string,
    action?: AcpAction,
  ): Promise<AcpSnapshot> {
    const response = await this.sandbox.containerFetch(
      `http://127.0.0.1/acp/${id}`,
      {
        method,
        headers: { "Content-Type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify(action) } : {}),
      },
      8766,
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (body?.error === "Stop all running Codex threads before signing out.")
        throw Error(body.error);
      throw Error("Codex bridge request failed.");
    }
    if (method === "DELETE")
      return { status: "disconnected", messages: [], permissions: [] };
    return response.json() as Promise<AcpSnapshot>;
  }
}
