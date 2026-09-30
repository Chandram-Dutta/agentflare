import type { DirectoryBackup, Sandbox } from "@cloudflare/sandbox";
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
const interactiveGraceMs = 30_000;
const backupTtl = 3_153_600_000; // 100 years. The R2 bucket must not expire backups/ via lifecycle rules.
type Persistence = {
  state: "saved" | "saving" | "error" | "disabled";
  savedAt?: string;
};
type SavedSnapshot = AcpSnapshot & {
  persistence: Persistence;
  interrupted?: boolean;
};
type BackupPointer = {
  backup: DirectoryBackup;
  savedAt: string;
  digest: string;
};
export class UserRuntime {
  private starting = new Map<string, Promise<RuntimeState>>();
  private publishing = new Map<string, Promise<PublishResult>>();
  private connecting?: Promise<void>;
  private signingOut = false;
  private authWrites: Promise<unknown> = Promise.resolve();
  private operations: Promise<unknown> = Promise.resolve();
  private snapshotDigests = new Map<string, string>();
  constructor(
    private sandbox: Sandbox<Bindings>,
    private storage: DurableObjectStorage,
    private env: Bindings,
    private identity: string,
  ) {}

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.operations.then(fn, fn);
    this.operations = next.catch(() => {});
    return next;
  }
  private async interactive<T>(fn: () => Promise<T>): Promise<T> {
    // Record presence before queuing so a waiting browser request also defers
    // a checkpoint. Persist the lease across Durable Object re-instantiation.
    await this.storage.put(
      "interactive-until",
      Date.now() + interactiveGraceMs,
    );
    return this.serialized(fn);
  }
  private persistenceConfigured() {
    const env = this.env;
    return !!(
      env.BACKUP_BUCKET &&
      env.BACKUP_BUCKET_NAME &&
      env.R2_ACCESS_KEY_ID &&
      env.R2_SECRET_ACCESS_KEY &&
      env.CLOUDFLARE_R2_ACCOUNT_ID
    );
  }
  private async snapshotKey(id: string) {
    const bytes = new TextEncoder().encode(`${this.identity}:${id}`);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return `runtime-snapshots/${[...new Uint8Array(hash)].map((n) => n.toString(16).padStart(2, "0")).join("")}.json`;
  }
  private async saveSnapshot(id: string, snapshot: AcpSnapshot) {
    if (!this.persistenceConfigured()) return;
    if (!snapshot.messages.length && snapshot.status !== "ready") return;
    // Never retain device-login URLs, permissions or native credentials in history.
    const value = JSON.stringify({
      status: snapshot.status,
      messages: snapshot.messages,
      truncated: snapshot.truncated,
      contextUsage: snapshot.contextUsage,
      configOptions: snapshot.configOptions,
    });
    const digest = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ).toString("hex");
    if (this.snapshotDigests.get(id) === digest) return;
    await this.env.BACKUP_BUCKET!.put(await this.snapshotKey(id), value, {
      httpMetadata: { contentType: "application/json" },
    });
    this.snapshotDigests.set(id, digest);
  }
  private async persistence(): Promise<Persistence> {
    if (!this.persistenceConfigured()) return { state: "disabled" };
    const pointer = await this.storage.get<BackupPointer>("runtime-backup");
    const revision = String(
      (await this.storage.get<number>("workspace-revision")) ?? 0,
    );
    return {
      state: (await this.storage.get("checkpoint-error"))
        ? "error"
        : pointer?.digest === revision
          ? "saved"
          : "saving",
      savedAt: pointer?.savedAt,
    };
  }
  private async dirty() {
    await this.storage.put(
      "workspace-revision",
      ((await this.storage.get<number>("workspace-revision")) ?? 0) + 1,
    );
  }
  async userSaved(id: string): Promise<SavedSnapshot> {
    this.root(id);
    if (await this.storage.get(`deleted:${id}`))
      throw Error("This thread's sandbox has been deleted.");
    if (!this.persistenceConfigured())
      return {
        status: "disconnected",
        messages: [],
        permissions: [],
        persistence: { state: "disabled" },
      };
    const object = await this.env.BACKUP_BUCKET!.get(
      await this.snapshotKey(id),
    );
    if (!object)
      return {
        status: "disconnected",
        messages: [],
        permissions: [],
        saved: true,
        persistence: await this.persistence(),
      };
    const saved = (await object.json()) as SavedSnapshot;
    const interrupted = [
      "running",
      "configuring",
      "connecting",
      "authenticating",
    ].includes(saved.status);
    return {
      ...saved,
      saved: true,
      persistence: await this.persistence(),
      status: "disconnected",
      interrupted,
      login: undefined,
      permissions: [],
      messages: saved.messages,
    };
  }

  private async restoreIfFresh() {
    if (!this.persistenceConfigured()) return;
    const exists = await this.sandbox.exec("test -d /workspace/threads");
    if (exists.success && !(await this.storage.get("restore-pending"))) return;
    const pointer = await this.storage.get<BackupPointer>("runtime-backup");
    if (!pointer) return;
    await this.storage.put("restore-pending", true);
    const result = await this.sandbox.restoreBackup(pointer.backup);
    if (!result.success) throw Error("Saved workspace restoration failed.");
    const deleted = await this.storage.list({ prefix: "deleted:" });
    for (const key of deleted.keys()) {
      const id = key.slice("deleted:".length);
      const removed = await this.sandbox.exec(
        `rm -rf -- ${quote(this.root(id))}`,
      );
      if (!removed.success) throw Error("Deleted workspace cleanup failed.");
    }
    await this.storage.delete("restore-pending");
  }

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
    await this.restoreIfFresh();
    if (
      !(
        await this.sandbox.exec(
          `test -d ${quote(`${this.root(id)}/repo/.git`)}`,
        )
      ).success
    )
      throw Error(
        this.persistenceConfigured()
          ? "Sandbox files are unavailable and the saved workspace could not be restored."
          : "Sandbox files are no longer available because workspace persistence is disabled.",
      );
  }
  start(id: string, input: UserStart): Promise<RuntimeState> {
    return this.interactive(() => this.startUnlocked(id, input));
  }
  private async startUnlocked(
    id: string,
    input: UserStart,
  ): Promise<RuntimeState> {
    if (this.starting.has(id)) return this.starting.get(id)!;
    const pending = (async () => {
      await this.restoreIfFresh();
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
      await this.dirty();
      // The callback or controlled shutdown captures this once presence expires.
      await this.checkpointUnlocked().catch(() => {});
      return state;
    })();
    this.starting.set(id, pending);
    try {
      return await pending;
    } finally {
      this.starting.delete(id);
    }
  }
  inspect(id: string, operation: string, path = "", staged = false) {
    return this.interactive(() =>
      this.inspectUnlocked(id, operation, path, staged),
    );
  }
  private async inspectUnlocked(
    id: string,
    operation: string,
    path = "",
    staged = false,
  ) {
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
    return this.interactive(() => this.reviewUnlocked(id));
  }
  private async reviewUnlocked(id: string): Promise<BranchReview> {
    const review = await this.inspectUnlocked(id, "review");
    const state = (await this.storage.get<Workspace>(`workspace:${id}`))!;
    return {
      ...review,
      baseBranch: state.baseBranch,
      published: (await this.storage.get<PublishState>(`publish:${id}`))
        ?.result,
    };
  }
  publish(
    id: string,
    input: PublishInput & { branch: string; token: string },
  ): Promise<PublishResult> {
    return this.interactive(() => this.publishUnlocked(id, input));
  }
  private async publishUnlocked(
    id: string,
    input: PublishInput & { branch: string; token: string },
  ): Promise<PublishResult> {
    if (this.publishing.has(id))
      throw Error("Publishing is already in progress.");
    const pending = (async () => {
      const snapshot = await this.inspectUnlocked(id, "snapshot");
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
  delete(id: string) {
    return this.interactive(() => this.deleteUnlocked(id));
  }
  private async deleteUnlocked(id: string) {
    const root = this.root(id);
    await this.storage.put(`deleted:${id}`, true);
    await this.restoreIfFresh();
    if (this.persistenceConfigured())
      await this.env.BACKUP_BUCKET!.delete(await this.snapshotKey(id));
    await Promise.allSettled([
      this.starting.get(id),
      this.publishing.get(id),
      this.connecting,
    ]);
    const process = await this.sandbox.getProcess(processId);
    if (process && ["running", "starting"].includes(process.status)) {
      const health = await this.sandbox.containerFetch(
        "http://127.0.0.1/health",
        {},
        8766,
      );
      if (health.ok) await this.fetch(id, "DELETE");
    }
    const result = await this.sandbox.exec(`rm -rf -- ${quote(root)}`);
    if (!result.success) throw Error("Workspace cleanup failed.");
    await this.storage.delete([`workspace:${id}`, `publish:${id}`]);
    this.snapshotDigests.delete(id);
    await this.dirty();
    // A new consistent archive prevents an older archive resurrecting this thread.
    await this.checkpointUnlocked().catch(() => {});
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
      await this.restoreIfFresh();
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
        if (this.persistenceConfigured()) {
          const stopped = await this.sandbox.containerFetch(
            "http://127.0.0.1/quiesce",
            { method: "POST" },
            8766,
          );
          if (stopped.status !== 204)
            throw Error(
              "Previous Codex process is still stopping. Retry shortly.",
            );
        }
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
          AGENTFLARE_AUTH_CALLBACK: `${this.env.BETTER_AUTH_URL}/api/codex-checkpoint/${this.identity}`,
          ...(this.persistenceConfigured()
            ? {
                AGENTFLARE_WORKSPACE_CALLBACK: `${this.env.BETTER_AUTH_URL}/api/runtime-checkpoint/${this.identity}`,
              }
            : {}),
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
  acp(id: string, action?: AcpAction): Promise<AcpSnapshot> {
    return this.interactive(() => this.acpUnlocked(id, action));
  }
  private async acpUnlocked(
    id: string,
    action?: AcpAction,
  ): Promise<AcpSnapshot> {
    if (this.signingOut) throw Error("Codex sign-out is in progress.");
    if (action?.type === "logout") this.signingOut = true;
    try {
      await this.require(id);
      await this.connect();
      await this.status(id);
      if (action && !["connect", "logout"].includes(action.type))
        await this.dirty();
      const snapshot = await this.fetch(id, action ? "POST" : "GET", action);
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
      await this.saveSnapshot(id, snapshot).catch(async () => {
        await this.storage.put("checkpoint-error", true);
      });
      return {
        ...snapshot,
        authScope: "user",
        persistence: await this.persistence(),
      };
    } finally {
      if (action?.type === "logout") this.signingOut = false;
    }
  }

  checkpoint(token: string): Promise<{ saved: boolean } | false> {
    return this.serialized(async () => {
      if (
        !token ||
        token !== (await this.storage.get<string>("auth-capability"))
      )
        return false;
      return { saved: await this.checkpointUnlocked() };
    });
  }

  prepareSleep(stop?: () => Promise<void>): Promise<boolean> {
    return this.serialized(async () => {
      if (!(await this.checkpointUnlocked(true))) return false;
      // Keep the fence through shutdown: a prompt accepted between the archive
      // and stopping the container would otherwise be deliberately discarded.
      await stop?.();
      return true;
    });
  }

  private async checkpointUnlocked(shuttingDown = false): Promise<boolean> {
    try {
      return await this.captureCheckpoint(shuttingDown);
    } catch (error) {
      await this.storage.put("checkpoint-error", true);
      throw error;
    }
  }

  private async captureCheckpoint(shuttingDown: boolean): Promise<boolean> {
    if (!this.persistenceConfigured()) return true;
    // An aborted restore must never be backed up as a new complete workspace.
    if (await this.storage.get("restore-pending")) return false;
    const process = await this.sandbox.getProcess(processId);
    const running = process && ["starting", "running"].includes(process.status);
    const live =
      running &&
      (await this.sandbox.containerFetch("http://127.0.0.1/health", {}, 8766))
        .ok;
    if (live) {
      const activity = await this.sandbox.containerFetch(
        "http://127.0.0.1/activity",
        {},
        8766,
      );
      if (!activity.ok) throw Error("Runtime activity unavailable.");
      const sessions = (await activity.json()) as Record<
        string,
        { status: AcpSnapshot["status"] }
      >;
      for (const id of Object.keys(sessions)) {
        if (await this.storage.get(`deleted:${id}`)) continue;
        const snapshot = await this.fetch(id, "GET");
        await this.saveSnapshot(id, snapshot);
      }
      if (
        Object.values(sessions).some((session) =>
          ["running", "configuring", "connecting", "authenticating"].includes(
            session.status,
          ),
        )
      )
        return false; // transcripts are durable; active workspace writes are not.
    }
    const previous = await this.storage.get<BackupPointer>("runtime-backup");
    if (
      previous?.digest ===
      String((await this.storage.get<number>("workspace-revision")) ?? 0)
    ) {
      await this.storage.delete("checkpoint-error");
      return true;
    }
    // Full archives stop native Codex and upload under the operation fence.
    // Never initiate that disruptive work between messages in an active UI.
    // Transcript saves above still run; the callback retries after presence expires.
    if (
      !shuttingDown &&
      Date.now() < ((await this.storage.get<number>("interactive-until")) ?? 0)
    )
      return false;
    if (running) {
      // Health 503 is not proof that native writers exited. A failed quiesce
      // must be retried, never bypassed on the next checkpoint attempt.
      const quiesced = await this.sandbox.containerFetch(
        "http://127.0.0.1/quiesce",
        { method: "POST" },
        8766,
      );
      if (quiesced.status === 409) return false;
      if (quiesced.status !== 204)
        throw Error("Runtime could not be quiesced.");
    }
    await this.saveWorkspaceCheckpoint();
    await this.storage.delete("checkpoint-error");
    return true;
  }

  private async saveWorkspaceCheckpoint() {
    if (!this.persistenceConfigured()) return;
    const digest = String(
      (await this.storage.get<number>("workspace-revision")) ?? 0,
    );
    const previous = await this.storage.get<BackupPointer>("runtime-backup");
    if (previous?.digest === digest) return;
    const backup = await this.sandbox.createBackup({
      dir: "/workspace",
      gitignore: false,
      excludes: [".codex/auth.json"],
      ttl: backupTtl,
    });
    const savedAt = new Date().toISOString();
    // Publish only after the SDK completed archive and metadata upload.
    await this.storage.put("runtime-backup", {
      backup,
      savedAt,
      digest,
    } satisfies BackupPointer);
    if (previous && previous.backup.id !== backup.id) {
      const bucket = this.env.BACKUP_BUCKET!;
      await bucket
        .delete([
          `backups/${previous.backup.id}/data.sqsh`,
          `backups/${previous.backup.id}/meta.json`,
        ])
        .catch(() => {});
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
