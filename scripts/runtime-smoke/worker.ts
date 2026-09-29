// Local-only integration fixture. This entrypoint is never imported by the app.
import { getSandbox } from "@cloudflare/sandbox";
import { ThreadSandbox } from "../../src/server/sandbox";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
export { ThreadSandbox };

const worker = {
  async fetch(
    request: Request,
    env: { Sandboxes: DurableObjectNamespace<ThreadSandbox> },
  ) {
    const url = new URL(request.url);
    if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1")
      return new Response("Local fixture only", { status: 403 });
    const sandbox = getSandbox<ThreadSandbox>(env.Sandboxes, "runtime-smoke");
    if (url.pathname === "/prepare") {
      const result = await sandbox.exec(
        "mkdir -p /tmp/source && git -C /tmp/source init && printf 'original\\n' > /tmp/source/README.md && git -C /tmp/source add . && git -C /tmp/source -c user.name=Test -c user.email=test@example.test commit -m initial",
      );
      if (!result.success) return Response.json(result, { status: 500 });
      const input = {
        repository: "file:///tmp/source",
        agent: "codex" as const,
        branch: "agentflare/smoke",
        name: "Test",
        cloneToken: "fake-local-only",
      };
      const states = await Promise.all([
        sandbox.startWorkspace(input),
        sandbox.startWorkspace(input),
      ]);
      await sandbox.exec(
        "printf 'staged\\n' > /workspace/repo/README.md && git -C /workspace/repo add README.md && printf 'working\\n' > /workspace/repo/README.md",
      );
      return Response.json({
        states,
        versions: await sandbox.exec("claude --version && codex --version"),
        files: await sandbox.inspectWorkspace("files"),
        staged: await sandbox.inspectWorkspace("diff", "README.md", true),
        working: await sandbox.inspectWorkspace("diff", "README.md", false),
      });
    }
    if (url.pathname === "/terminal") {
      const shell = await sandbox.prepareTerminal();
      if (!shell)
        return new Response("Start this thread first.", { status: 409 });
      const session = await sandbox.getSession("agent");
      return session.terminal(request, { cols: 100, rows: 30, shell });
    }
    if (url.pathname === "/pid")
      return Response.json(
        await sandbox.exec("ps -eo pid,args | grep '[c]odex'"),
      );
    if (url.pathname === "/destroy") {
      await sandbox.destroy();
      return new Response("destroyed");
    }
    return new Response("runtime smoke fixture");
  },
};
export default worker;
