import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBridge } from "./bridge.mjs";

const fake = fileURLToPath(new URL("./fake-agent.mjs", import.meta.url));
async function until(condition) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error("Expected protocol state did not arrive");
}
async function fixture(run) {
  const cwd = await mkdtemp(join(tmpdir(), "acp-test-"));
  const bridges = [];
  const start = (args = []) => {
    const bridge = createBridge({
      command: [process.execPath, fake, ...args],
      cwd,
      sessionFile: join(cwd, "session"),
    });
    bridges.push(bridge);
    return bridge;
  };
  try {
    await run(start, cwd);
  } finally {
    for (const b of bridges) await b.close();
    await rm(cwd, { recursive: true, force: true });
  }
}

test("device-code acceptance is not authentication; stream and permission choices survive reads", async () =>
  fixture(async (start) => {
    const b = start();
    await b.ready;
    expect(b.snapshot.status).toBe("auth-required");
    await b.act({ type: "authenticate" });
    await until(() => b.snapshot.login);
    expect(b.snapshot.login.message).toBe("Enter ABCD-EFGH");
    await b.act({ type: "login-response", id: "device", action: "accept" });
    expect(b.snapshot.status).toBe("authenticating");
    await until(() => b.snapshot.status === "ready");
    const prompt = { type: "prompt", text: "inspect", requestId: "unique" };
    await b.act(prompt);
    await b.act(prompt);
    await until(() => b.snapshot.permissions.length === 1);
    const snapshot = JSON.parse(JSON.stringify(b.snapshot));
    expect(snapshot.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(snapshot.messages.at(-1).text).toBe("Inspecting files.");
    const id = snapshot.permissions[0].id;
    await expect(
      b.act({ type: "permission", id, optionId: "invented" }),
    ).rejects.toThrow();
    expect(b.snapshot.status).toBe("running");
    await b.act({ type: "permission", id, optionId: "deny" });
    await until(() => b.snapshot.status === "ready");
    expect(b.snapshot.messages.at(-1).text).toContain("Denied.");
    await b.act(prompt);
    expect(b.snapshot.messages.filter((m) => m.role === "user")).toHaveLength(
      1,
    );
  }));

test("session reload preserves history and failed loads do not silently create a new session", async () =>
  fixture(async (start, cwd) => {
    await writeFile(join(cwd, "authenticated"), "synthetic");
    const first = start();
    await first.ready;
    await first.close();
    const second = start();
    await second.ready;
    expect(second.snapshot.status).toBe("ready");
    expect(second.snapshot.messages.map((m) => m.text)).toEqual([
      "previous task",
      "restored answer",
    ]);
    await second.close();
    const broken = start(["broken"]);
    await broken.ready;
    expect(broken.snapshot.status).toBe("error");
  }));

test("cancel releases permissions and process death disables prompt submission", async () =>
  fixture(async (start, cwd) => {
    await writeFile(join(cwd, "authenticated"), "synthetic");
    const b = start();
    await b.ready;
    await b.act({ type: "prompt", text: "inspect", requestId: "cancelled" });
    await until(() => b.snapshot.permissions.length === 1);
    await b.act({ type: "cancel" });
    await until(() => b.snapshot.status === "ready");
    expect(b.snapshot.permissions).toHaveLength(0);
    await b.act({ type: "prompt", text: "crash", requestId: "crash" });
    await until(() => b.snapshot.status === "error");
    await expect(
      b.act({ type: "prompt", text: "no", requestId: "no" }),
    ).rejects.toThrow();
  }));

test("large output is bounded and truncation is reported", async () =>
  fixture(async (start, cwd) => {
    await writeFile(join(cwd, "authenticated"), "synthetic");
    const b = start();
    await b.ready;
    await b.act({ type: "prompt", text: "long", requestId: "long" });
    await until(() => b.snapshot.status === "ready");
    expect(b.snapshot.truncated).toBe(true);
    expect(
      b.snapshot.messages.reduce((n, m) => n + m.text.length, 0),
    ).toBeLessThanOrEqual(128000);
    expect(b.snapshot.messages.at(-1).text.length).toBe(64000);
  }));
