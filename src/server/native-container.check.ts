import { expect, test } from "bun:test";

// Docker commit exercises the image/filesystem contract, not Cloudflare's
// snapshot service. The latter also needs a canary after the approved cutover.
test.skipIf(!process.env.COMPUTER_IMAGE)(
  "native disk and R2 restore source, ignored files and rollouts, but not ephemeral credentials",
  async () => {
    const name = `agentflare-native-${crypto.randomUUID()}`;
    const image = `${name}:snapshot`;
    async function docker(...args: string[]) {
      const child = Bun.spawn(["docker", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code) throw Error(stderr);
      return stdout.trim();
    }
    async function start(source: string) {
      await docker(
        "run",
        "-d",
        "--privileged",
        "--name",
        name,
        "-p",
        "127.0.0.1::8767",
        source,
      );
      const port = (await docker("port", name, "8767")).split(":").at(-1);
      const base = `http://127.0.0.1:${port}`;
      for (let i = 0; i < 100; i++) {
        if ((await fetch(`${base}/health`).catch(() => null))?.ok) return base;
        await Bun.sleep(100);
      }
      throw Error("Native image did not become ready");
    }
    const verify = () =>
      docker(
        "exec",
        name,
        "bash",
        "-c",
        "test ! -e /run/codex/auth.json && test ! -e /run/agentflare-bridge.pid && test -L /workspace/link && cat /workspace/source /workspace/node_modules/ignored /workspace/.codex/sessions/turn.jsonl",
      );
    try {
      const base = await start(process.env.COMPUTER_IMAGE!);
      await docker(
        "exec",
        name,
        "bash",
        "-c",
        "mkdir -p /workspace/node_modules /workspace/.codex/sessions /run/codex; printf source > /workspace/source; printf ignored > /workspace/node_modules/ignored; printf rollout > /workspace/.codex/sessions/turn.jsonl; ln -s source /workspace/link; printf synthetic-secret > /run/codex/auth.json; printf 999999 > /run/agentflare-bridge.pid",
      );
      const archive = await fetch(`${base}/workspace-archive`);
      expect(archive.ok).toBe(true);
      const bytes = await archive.arrayBuffer();
      await docker("commit", name, image);
      await docker("rm", "-f", name);
      await start(image);
      expect(await verify()).toBe("sourceignoredrollout");
      await docker("rm", "-f", name);
      const fresh = await start(process.env.COMPUTER_IMAGE!);
      const restored = await fetch(`${fresh}/workspace-archive`, {
        method: "POST",
        body: bytes,
      });
      expect(restored.status).toBe(204);
      expect(await verify()).toBe("sourceignoredrollout");
    } finally {
      await docker("rm", "-f", name).catch(() => {});
      await docker("image", "rm", image).catch(() => {});
    }
  },
  120_000,
);
