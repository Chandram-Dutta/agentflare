import { Sandbox } from "@cloudflare/sandbox";
import { shellArgument, type RuntimeState } from "@/lib/runtime";
import type { AgentId } from "@/lib/workspace";

type StartInput = {
  repository: string;
  agent: AgentId;
  branch: string;
  name: string;
  cloneToken: string;
};

export class ThreadSandbox extends Sandbox {
  private starting?: Promise<RuntimeState>;
  private startStage = "checking workspace";
  sleepAfter = "30m";

  async workspaceStatus(): Promise<RuntimeState> {
    return (
      (await this.ctx.storage.get<RuntimeState>("workspace")) ?? {
        started: false,
      }
    );
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
    const input = Buffer.from(
      JSON.stringify({ operation, path, staged }),
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
}
