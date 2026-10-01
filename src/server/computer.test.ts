import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Computer lifecycle and optional real-container checks", async () => {
  // Isolate the workerd host: Bun/Miniflare stalls booting this larger Worker
  // after another Miniflare instance is disposed in the same test process.
  const directory = await mkdtemp(join(tmpdir(), "agentflare-computer-"));
  try {
    const entry = join(directory, "runtime.test.ts");
    await Bun.write(
      entry,
      `import ${JSON.stringify(new URL("./computer.check.ts", import.meta.url).pathname)};`,
    );
    const process = Bun.spawn(["bun", "test", entry], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect(code, stdout + stderr).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 90000);
