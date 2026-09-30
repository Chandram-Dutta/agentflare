import { Sandbox } from "@cloudflare/sandbox";
import type { AcpAction, AcpSnapshot } from "@/lib/acp";
import { shellArgument, type RuntimeState } from "@/lib/runtime";
import type { AgentId } from "@/lib/workspace";
import type { BranchReview, PublishInput, PublishResult } from "@/lib/runtime";
import { publishSnapshot, type PublishState } from "./publish";
import type { Bindings } from "./env";
import { UserRuntime, type UserStart } from "./user-runtime";

type StartInput = {
  repository: string;
  agent: AgentId;
  branch: string;
  name: string;
  cloneToken: string;
};

export class ThreadSandbox extends Sandbox<Bindings> {
  private shared = new UserRuntime(
    this,
    this.ctx.storage,
    this.env,
    this.ctx.id.toString(),
  );
  userStatus(id: string) {
    return this.shared.status(id);
  }
  userStart(id: string, input: UserStart) {
    return this.shared.start(id, input);
  }
  userDelete(id: string) {
    return this.shared.delete(id);
  }
  userInspect(id: string, operation: string, path = "", staged = false) {
    return this.shared.inspect(id, operation, path, staged);
  }
  userReview(id: string) {
    return this.shared.review(id);
  }
  userPublish(
    id: string,
    input: PublishInput & { branch: string; token: string },
  ) {
    return this.shared.publish(id, input);
  }
  userAcp(id: string, action?: AcpAction) {
    return this.shared.acp(id, action);
  }
  saveCodexCredentials(token: string, value: string | null) {
    return this.shared.persist(token, value);
  }
  private starting?: Promise<RuntimeState>;
  private startingAcp?: Promise<AcpSnapshot>;
  private publishing?: Promise<PublishResult>;
  private startStage = "checking workspace";
  sleepAfter = "30m";

  async workspaceStatus(): Promise<RuntimeState> {
    if (await this.ctx.storage.get("app:deleted"))
      throw new Error("This thread's sandbox has been deleted.");
    return (
      (await this.ctx.storage.get<RuntimeState>("workspace")) ?? {
        started: false,
      }
    );
  }

  async deleteWorkspace(): Promise<void> {
    // Fence future application operations before waiting for existing startup.
    // The SDK's destroy() preserves this application-owned tombstone.
    await this.ctx.storage.put("app:deleted", true);
    await Promise.allSettled([
      this.starting,
      this.startingAcp,
      this.publishing,
    ]);
    await this.destroy();
    await this.ctx.storage.delete("workspace");
  }

  async startWorkspace(input: StartInput): Promise<RuntimeState> {
    if (this.starting) return this.starting;
    this.starting = this.initializeWorkspace(input);
    try {
      return await this.starting;
    } catch (error) {
      // SDK error contexts can include commands and environment variables.
      // Record only the stage, error type/code, and stack frames, never context.
      console.error({
        event: "workspace_start_failed",
        stage: this.startStage,
        type: error instanceof Error ? error.name : "unknown",
        code:
          error && typeof error === "object" && "code" in error
            ? String(error.code)
                .replace(/[^A-Z_0-9]/g, "")
                .slice(0, 80)
            : undefined,
        frames:
          error instanceof Error
            ? error.stack?.split("\n").filter((line) => /^\s+at /.test(line))
            : undefined,
      });
      throw new Error(`Workspace startup failed during ${this.startStage}.`);
    } finally {
      this.starting = undefined;
    }
  }

  private async initializeWorkspace(input: StartInput): Promise<RuntimeState> {
    this.startStage = "checking workspace";
    const previous = await this.workspaceStatus();
    if (previous.started) {
      if (
        previous.repository !== input.repository ||
        previous.agent !== input.agent
      )
        throw new Error(
          "This thread already started with another repository or agent. Create a new thread.",
        );
      this.startStage = "checking existing sandbox files";
      await this.requireWorkspace();
      return previous;
    }
    this.startStage = "starting container";
    const ready = await this.exec("true", { timeout: 10000 });
    if (!ready.success) throw new Error("Container readiness check failed.");
    this.startStage = "checking out repository";
    // No lifecycle scripts or repository-provided commands run during cloning.
    const command = `git -c credential.helper= -c http.extraHeader="Authorization: Basic $AGENTFLARE_CLONE_AUTH" clone -- ${shellArgument(input.repository)} /workspace/repo && git -C /workspace/repo switch -c ${shellArgument(input.branch)} && git -C /workspace/repo config user.name ${shellArgument(input.name)} && git -C /workspace/repo config user.email agent@agentflare.invalid`;
    const result = await this.exec(command, {
      env: {
        AGENTFLARE_CLONE_AUTH: Buffer.from(
          `x-access-token:${input.cloneToken}`,
        ).toString("base64"),
        GIT_TERMINAL_PROMPT: "0",
      },
      timeout: 120000,
    });
    if (!result.success)
      throw new Error(
        "Repository checkout failed. Check GitHub App access; create a new thread to retry a partial checkout.",
      );
    this.startStage = "creating agent session";
    await this.createSession({
      id: "agent",
      cwd: "/workspace/repo",
      env: { TERM: "xterm-256color" },
    });
    const state: RuntimeState = {
      started: true,
      repository: input.repository,
      agent: input.agent,
    };
    this.startStage = "saving workspace state";
    await this.ctx.storage.put("workspace", state);
    await this.reviewBase();
    return state;
  }

  private async requireWorkspace() {
    const result = await this.exec("test -d /workspace/repo/.git");
    if (!result.success)
      throw new Error(
        "Sandbox files are no longer available. Create a new thread. Checkpoints are not implemented yet.",
      );
  }

  async prepareTerminal(): Promise<AgentId | null> {
    const state = await this.workspaceStatus();
    if (!state.started || !state.agent) return null;
    await this.requireWorkspace();
    // Only serializable data may cross RPC; WebSocket upgrades use fetch.
    return state.agent;
  }

  async inspectWorkspace(operation: string, path = "", staged = false) {
    if (!(await this.workspaceStatus()).started)
      throw new Error("Start this thread first.");
    await this.requireWorkspace();
    const base = ["review", "snapshot", "branch-diff"].includes(operation)
      ? await this.reviewBase()
      : undefined;
    const input = Buffer.from(
      JSON.stringify({ operation, path, staged, base: base?.baseSha }),
    ).toString("base64");
    const result = await this.exec(
      `node /opt/agentflare/repository.mjs ${shellArgument(input)}`,
      { timeout: 15000 },
    );
    if (!result.success)
      throw new Error(
        "Repository operation failed. The path may be missing, binary, too large, or outside the checkout.",
      );
    return JSON.parse(result.stdout);
  }

  private async reviewBase(): Promise<{ baseSha: string; baseBranch: string }> {
    const saved = await this.ctx.storage.get<{
      baseSha: string;
      baseBranch: string;
    }>("review-base");
    if (saved) return saved;
    const result = await this.exec(
      "git -C /workspace/repo symbolic-ref --short refs/remotes/origin/HEAD && git -C /workspace/repo merge-base HEAD origin/HEAD",
    );
    const [ref, baseSha] = result.stdout.trim().split("\n");
    if (
      !result.success ||
      !ref?.startsWith("origin/") ||
      !/^[a-f0-9]{40}$/.test(baseSha)
    )
      throw Error("Cannot determine the thread's base branch.");
    const base = { baseBranch: ref.slice(7), baseSha };
    await this.ctx.storage.put("review-base", base);
    return base;
  }

  async reviewWorkspace(): Promise<BranchReview> {
    const review = await this.inspectWorkspace("review");
    const base = await this.reviewBase();
    const published = (await this.ctx.storage.get<PublishState>("publish"))
      ?.result;
    return { ...review, baseBranch: base.baseBranch, published };
  }

  async publishWorkspace(
    input: PublishInput & { branch: string; token: string },
  ): Promise<PublishResult> {
    if (this.publishing) throw Error("Publishing is already in progress.");
    this.publishing = (async () => {
      const workspace = await this.workspaceStatus();
      if (!workspace.started || !workspace.repository)
        throw Error("Start this thread first.");
      const snapshot = await this.inspectWorkspace("snapshot");
      const base = await this.reviewBase();
      return publishSnapshot({
        ...input,
        ...base,
        repository: workspace.repository,
        snapshot,
        state: (await this.ctx.storage.get<PublishState>("publish")) ?? {},
        save: (state) => this.ctx.storage.put("publish", state),
      });
    })();
    try {
      return await this.publishing;
    } finally {
      this.publishing = undefined;
    }
  }

  private disconnectedAcp(): AcpSnapshot {
    return { status: "disconnected", messages: [], permissions: [] };
  }

  async acpSnapshot(): Promise<AcpSnapshot> {
    const state = await this.workspaceStatus();
    if (!state.started || state.agent !== "codex")
      return this.disconnectedAcp();
    await this.requireWorkspace();
    const process = await this.getProcess("agentflare-acp");
    if (!process || !["starting", "running"].includes(process.status))
      return this.disconnectedAcp();
    try {
      return await this.fetchAcp("GET");
    } catch {
      return {
        ...this.disconnectedAcp(),
        status: "error",
        error: "The Codex bridge stopped. Connect again.",
      };
    }
  }

  async acpAction(action: AcpAction): Promise<AcpSnapshot> {
    const state = await this.workspaceStatus();
    if (!state.started) throw new Error("Start this thread first.");
    if (state.agent !== "codex")
      throw new Error("This thread does not use Codex.");
    await this.requireWorkspace();
    if (action.type === "connect") return this.startAcp();
    const process = await this.getProcess("agentflare-acp");
    if (!process || !["starting", "running"].includes(process.status))
      throw new Error("Connect Codex first.");
    return this.fetchAcp("POST", action);
  }

  private async startAcp(): Promise<AcpSnapshot> {
    if (this.startingAcp) return this.startingAcp;
    this.startingAcp = (async () => {
      const existing = await this.getProcess("agentflare-acp");
      if (existing && ["starting", "running"].includes(existing.status)) {
        try {
          const snapshot = await this.fetchAcp("GET");
          if (snapshot.status !== "error") return snapshot;
        } catch {}
        await this.killProcess("agentflare-acp").catch(() => {});
      }
      const image = await this.exec("test -r /opt/agentflare/acp/bridge.mjs");
      if (!image.success)
        throw new Error(
          "This sandbox is using an older image without Codex ACP. Start a new thread.",
        );
      await this.startProcess("bun /opt/agentflare/acp/bridge.mjs", {
        processId: "agentflare-acp",
        autoCleanup: false,
      });
      for (let attempt = 0; attempt < 60; attempt++) {
        try {
          return await this.fetchAcp("GET");
        } catch {}
        const process = await this.getProcess("agentflare-acp");
        if (process && !["starting", "running"].includes(process.status))
          throw new Error(
            "The Codex bridge exited during startup. Check the container logs.",
          );
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error("Codex bridge did not become ready.");
    })();
    try {
      return await this.startingAcp;
    } finally {
      this.startingAcp = undefined;
    }
  }

  private async fetchAcp(
    method: "GET" | "POST",
    action?: AcpAction,
  ): Promise<AcpSnapshot> {
    const response = await this.containerFetch(
      "http://127.0.0.1/acp",
      {
        method,
        headers: { "Content-Type": "application/json" },
        ...(action ? { body: JSON.stringify(action) } : {}),
      },
      8766,
    );
    if (!response.ok) throw new Error("Codex bridge request failed.");
    return (await response.json()) as AcpSnapshot;
  }
}
