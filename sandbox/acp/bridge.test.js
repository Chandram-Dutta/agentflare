import { test, expect } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createUserBridge } from "./bridge.mjs";
import { createCheckpointLoop } from "./checkpoint-loop.mjs";

const fake = fileURLToPath(new URL("./fake-agent.mjs", import.meta.url));
const richAttachments = [
  { type: "image", mimeType: "image/png", data: "aGk=" },
  { type: "audio", mimeType: "audio/wav", data: "aGk=" },
  { type: "resource", resource: { uri: "attachment:///note.txt", text: "literal <script>" } },
  { type: "resource_link", uri: "file:///workspace/file.txt", name: "file.txt" },
];
async function until(condition) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error("Expected protocol state did not arrive");
}
async function fixture(run) {
  const cwd = await mkdtemp(join(tmpdir(), "acp-test-"));
  await mkdir(join(cwd, threadA, "repo"), { recursive: true });
  const bridges = [];
  const start = (args = []) => {
    const bridge = createUserBridge({ command: [process.execPath, fake, "shared", ...args], root: cwd });
    bridges.push(bridge);
    const opened = bridge.session(threadA);
    let session;
    let closed = false;
    return {
      get snapshot() { return session?.snapshot ?? { status: "connecting", messages: [], permissions: [], configOptions: [] }; },
      ready: opened.then((value) => { session = value; return value.ready; }),
      act: (action) => session ? session.act(action) : opened.then((value) => value.act(action)),
      close: () => {
        if (closed) return;
        closed = true;
        return bridge.close();
      },
    };
  };
  try {
    await run(start, cwd);
  } finally {
    for (const b of bridges) await b.close();
    await rm(cwd, { recursive: true, force: true });
  }
}

test("rich prompts preserve block order in messages and tool output", async () =>
  fixture(async (start, cwd) => {
    await writeFile(join(cwd, "authenticated"), "synthetic");
    const b = start();
    await b.ready;
    expect(b.snapshot.promptCapabilities.image).toBe(true);
    await b.act({ type: "prompt", text: "rich", attachments: richAttachments, requestId: "rich" });
    await until(() => b.snapshot.status === "ready");
    expect(b.snapshot.messages[0].content).toEqual([{ type: "text", text: "rich" }, ...richAttachments]);
    const answers = b.snapshot.messages.filter(m => m.role === "assistant");
    expect(answers).toHaveLength(1);
    expect(answers[0].content).toEqual([{ type: "text", text: "rich" }, ...richAttachments]);
    expect(b.snapshot.messages.at(-1).content).toEqual([{ type: "text", text: "rich" }, ...richAttachments]);
    await b.act({ type: "prompt", text: "", attachments: [richAttachments[0]], requestId: "image-only" });
    await until(() => b.snapshot.status === "ready");
    expect(b.snapshot.messages.at(-1).content).toEqual([richAttachments[0]]);
  }));

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
    expect(snapshot.messages.at(-1).text).toContain(`session-${threadA}`);
    expect(snapshot.messages.at(-1).text).toEndWith("files.");
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
    await writeFile(join(cwd, threadA, "acp-session"), "saved-session");
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

test("new and loaded sessions expose runtime config without boolean capability", async () =>
  fixture(async (start, cwd) => {
    await writeFile(join(cwd, "authenticated"), "synthetic");
    const first = start();
    await first.ready;
    expect(first.snapshot.configOptions.map((option) => option.id)).toEqual([
      "mode", "model", "reasoning_effort", "fast-mode",
    ]);
    expect(first.snapshot.configOptions[0].options.map((option) => option.value)).toEqual([
      "read-only", "workspace-write", "agent", "agent-full-access",
    ]);
    await first.close();
    const loaded = start();
    await loaded.ready;
    expect(loaded.snapshot.configOptions.find((option) => option.id === "model")?.currentValue).toBe("small");
  }));

test("model changes replace options, clear usage, and serialize prompts", async () =>
  fixture(async (start, cwd) => {
    await writeFile(join(cwd, "authenticated"), "synthetic");
    await writeFile(join(cwd, threadA, "acp-session"), "saved-session");
    const b = start();
    await b.ready;
    await b.act({ type: "prompt", text: "telemetry", requestId: "usage" });
    await until(() => b.snapshot.status === "ready");
    expect(b.snapshot.contextUsage).toEqual({ used: 13, size: 101 });
    const changing = b.act({ type: "set-config", configId: "model", value: "large" });
    expect(b.snapshot.status).toBe("configuring");
    await expect(b.act({ type: "prompt", text: "race", requestId: "race" })).rejects.toThrow();
    await expect(b.act({ type: "set-config", configId: "model", value: "small" })).rejects.toThrow();
    await changing;
    expect(b.snapshot.contextUsage).toBeUndefined();
    expect(b.snapshot.configOptions.map((option) => option.id)).toEqual(["model", "reasoning_effort"]);
    expect(b.snapshot.configOptions[1].options.map((option) => option.value)).toEqual(["medium"]);
  }));

test("agent death during configuration cannot restore ready state", async () =>
  fixture(async (start, cwd) => {
    await writeFile(join(cwd, "authenticated"), "synthetic");
    const b = start(["crash-config"]);
    await b.ready;
    await expect(b.act({ type: "set-config", configId: "model", value: "large" })).rejects.toThrow();
    expect(b.snapshot.status).toBe("error");
    await expect(b.act({ type: "prompt", text: "inspect", requestId: "after-crash" })).rejects.toThrow();
  }));

test("invented config choices are rejected without mutating state", async () =>
  fixture(async (start, cwd) => {
    await writeFile(join(cwd, "authenticated"), "synthetic");
    const b = start();
    await b.ready;
    const before = JSON.stringify(b.snapshot.configOptions);
    await expect(b.act({ type: "set-config", configId: "invented", value: "x" })).rejects.toThrow();
    await expect(b.act({ type: "set-config", configId: "model", value: "invented" })).rejects.toThrow();
    expect(JSON.stringify(b.snapshot.configOptions)).toBe(before);
    expect(b.snapshot.status).toBe("ready");
  }));

test("config updates replace the list and thought chunks stay separate from answers", async () =>
  fixture(async (start, cwd) => {
    await writeFile(join(cwd, "authenticated"), "synthetic");
    await writeFile(join(cwd, threadA, "acp-session"), "saved-session");
    const b = start();
    await b.ready;
    await b.act({ type: "prompt", text: "telemetry", requestId: "telemetry" });
    await until(() => b.snapshot.status === "ready");
    expect(b.snapshot.messages.slice(-2).map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "thought", text: "explicit thought" },
      { role: "assistant", text: "visible answer" },
    ]);
    await b.act({ type: "prompt", text: "config-event", requestId: "event" });
    await until(() => b.snapshot.status === "ready");
    expect(b.snapshot.configOptions.map((option) => option.id)).toEqual(["collaboration_mode"]);
  }));

const threadA = "11111111-1111-4111-8111-111111111111";
const threadB = "22222222-2222-4222-8222-222222222222";
async function sharedFixture(authenticated, run) {
  const root = await mkdtemp(join(tmpdir(), "acp-shared-"));
  for (const id of [threadA, threadB]) await mkdir(join(root, id, "repo"), { recursive: true });
  if (authenticated) await writeFile(join(root, "authenticated"), "synthetic");
  const bridge = createUserBridge({ command: [process.execPath, fake, "shared"], root });
  try { await run(bridge, root); } finally { await bridge.close(); await rm(root, { recursive: true, force: true }); }
}

test("shared rich content remains isolated by session", async () => {
  await sharedFixture(true, async (bridge) => {
    const a = await bridge.session(threadA);
    const b = await bridge.session(threadB);
    await Promise.all([a.ready, b.ready]);
    await a.act({ type: "prompt", text: "rich", requestId: "rich", attachments: richAttachments });
    await until(() => a.snapshot.status === "ready");
    expect(a.snapshot.messages.filter(m => m.role === "assistant")).toHaveLength(1);
    expect(a.snapshot.messages.at(-1).content).toEqual([{ type: "text", text: "rich" }, ...richAttachments]);
    expect(b.snapshot.messages).toEqual([]);
  });
});

test("reconnect retries a failed load once without replacing history or interrupting siblings", async () => {
  await sharedFixture(true, async (bridge, root) => {
    await writeFile(join(root, threadA, "acp-session"), "saved-session");
    await writeFile(join(root, "fail-load"), "yes");
    const a = await bridge.session(threadA);
    const b = await bridge.session(threadB);
    await Promise.all([a.ready, b.ready]);
    expect(a.snapshot.status).toBe("error");
    expect(a.snapshot.error).toContain("could not find the saved session");
    expect(a.snapshot.error).not.toContain("synthetic-private-detail");
    await b.act({ type: "prompt", text: "inspect", requestId: "sibling" });
    await until(() => b.snapshot.permissions.length === 1);
    // A permanent failure must not be replaced with an empty new session.
    await a.act({ type: "connect" });
    await a.ready;
    expect(a.snapshot.status).toBe("error");
    expect(await readFile(join(root, threadA, "acp-session"), "utf8")).toBe("saved-session");
    await rm(join(root, "fail-load"));
    await Promise.all([a.act({ type: "connect" }), a.act({ type: "connect" })]);
    await a.ready;
    expect(a.snapshot.status).toBe("ready");
    expect(a.snapshot.error).toBeUndefined();
    expect(a.snapshot.messages.map(m => m.text)).toEqual(["previous task", "restored answer"]);
    expect(b.snapshot.status).toBe("running");
    expect(b.snapshot.permissions).toHaveLength(1);
    await a.act({ type: "connect" });
    await b.act({ type: "connect" });
    const calls = (await readFile(join(root, "requests"), "utf8")).trim().split("\n");
    expect(calls.filter(x => x === "session/load")).toHaveLength(3);
    expect(calls.filter(x => x === "session/new")).toHaveLength(1);
    expect(calls.filter(x => x === "session/prompt")).toHaveLength(1);
  });
});

test("usage errors are actionable and a failed reconnect preserves the visible conversation", async () => {
  await sharedFixture(true, async (bridge, root) => {
    const a = await bridge.session(threadA);
    await a.ready;
    await a.act({ type: "prompt", text: "quota", requestId: "failed-turn" });
    await until(() => a.snapshot.status === "error");
    expect(a.snapshot.error).toContain("usage limit reached");
    expect(a.snapshot.error).not.toContain("synthetic-private-detail");
    const messages = structuredClone(a.snapshot.messages);
    await writeFile(join(root, "fail-load"), "yes");
    await a.act({ type: "connect" });
    await a.ready;
    expect(a.snapshot.status).toBe("error");
    expect(a.snapshot.messages).toEqual(messages);
    expect((await readFile(join(root, "requests"), "utf8")).split("\n").filter(x => x === "session/prompt")).toHaveLength(1);
  });
});

test("shared bridge isolates routing and deletion", async () => {
  await sharedFixture(true, async (bridge) => {
    expect(bridge.activity()).toEqual({});
    const a = await bridge.session(threadA);
    const b = await bridge.session(threadB);
    await Promise.all([a.ready, b.ready]);
    await a.act({ type: "prompt", text: "inspect", requestId: "same-id" });
    await b.act({ type: "prompt", text: "inspect", requestId: "same-id" });
    await until(() => a.snapshot.permissions.length === 1 && b.snapshot.permissions.length === 1);
    expect(bridge.activity()).toEqual({
      [threadA]: { status: "running", attention: true, attentionId: a.snapshot.permissions[0].id, turn: "same-id" },
      [threadB]: { status: "running", attention: true, attentionId: b.snapshot.permissions[0].id, turn: "same-id" },
    });
    expect(a.snapshot.messages.at(-1).text).toContain(threadA);
    expect(b.snapshot.messages.at(-1).text).toContain(threadB);
    await expect(a.act({ type: "permission", id: b.snapshot.permissions[0].id, optionId: "deny" })).rejects.toThrow();
    await a.act({ type: "permission", id: a.snapshot.permissions[0].id, optionId: "deny" });
    await b.act({ type: "permission", id: b.snapshot.permissions[0].id, optionId: "allow" });
    await until(() => a.snapshot.status === "ready" && b.snapshot.status === "ready");
    expect(bridge.activity()[threadA]).toEqual({ status: "ready", attention: false, turn: "same-id" });
    await bridge.deleteSession(threadA);
    expect(bridge.activity()[threadA]).toBeUndefined();
    await b.act({ type: "prompt", text: "inspect", requestId: "still-alive" });
    await until(() => b.snapshot.permissions.length === 1);
    expect(b.snapshot.status).toBe("running");
  });
});

test("authentication is global and logout checks every session", async () => {
  await sharedFixture(false, async (bridge) => {
    const a = await bridge.session(threadA);
    const b = await bridge.session(threadB);
    await Promise.all([a.ready, b.ready]);
    await a.act({ type: "authenticate" });
    await until(() => a.snapshot.login && b.snapshot.login);
    await b.act({ type: "login-response", id: "device", action: "accept" });
    await until(() => a.snapshot.status === "ready" && b.snapshot.status === "ready");
    await a.act({ type: "prompt", text: "inspect", requestId: "busy" });
    await until(() => a.snapshot.permissions.length === 1);
    await expect(b.act({ type: "logout" })).rejects.toThrow("busy");
    await a.act({ type: "permission", id: a.snapshot.permissions[0].id, optionId: "deny" });
    await until(() => a.snapshot.status === "ready");
    await b.act({ type: "logout" });
    expect([a.snapshot.status, b.snapshot.status]).toEqual(["auth-required", "auth-required"]);
  });
});

test("shared replay is routed before load returns and process death errors every session", async () => {
  await sharedFixture(true, async (bridge, root) => {
    await writeFile(join(root, threadA, "acp-session"), `session-${threadA}`);
    await writeFile(join(root, threadB, "acp-session"), `session-${threadB}`);
    const a = await bridge.session(threadA);
    const b = await bridge.session(threadB);
    await Promise.all([a.ready, b.ready]);
    for (const session of [a,b]) expect(session.snapshot.messages.map(m => m.text)).toEqual(["previous task", "restored answer"]);
    await a.act({ type:"prompt",text:"crash",requestId:"fatal" });
    await until(() => a.snapshot.status === "error" && b.snapshot.status === "error");
    await expect(b.act({type:"prompt",text:"inspect",requestId:"after-death"})).rejects.toThrow();
  });
});

test("deleting a running shared session settles its turn without stopping its sibling", async () => {
  await sharedFixture(true, async bridge => {
    const a = await bridge.session(threadA);
    const b = await bridge.session(threadB);
    await Promise.all([a.ready,b.ready]);
    await a.act({type:"prompt",text:"inspect",requestId:"delete-running"});
    await until(() => a.snapshot.permissions.length === 1);
    await bridge.deleteSession(threadA);
    await expect(bridge.session(threadA)).rejects.toThrow();
    expect(b.snapshot.status).toBe("ready");
    await b.act({type:"set-config",configId:"model",value:"large"});
    expect(b.snapshot.configOptions[0].currentValue).toBe("large");
  });
});

test("quiesce refuses busy work without fencing the bridge", async () => {
  await sharedFixture(true, async (bridge) => {
    const a = await bridge.session(threadA);
    await a.ready;
    await a.act({ type: "prompt", text: "inspect", requestId: "busy-checkpoint" });
    await until(() => a.snapshot.permissions.length === 1);
    expect(await bridge.quiesce()).toBe(false);
    await a.act({ type: "permission", id: a.snapshot.permissions[0].id, optionId: "deny" });
    await until(() => a.snapshot.status === "ready");
    await a.act({ type: "set-config", configId: "model", value: "large" });
    expect(a.snapshot.status).toBe("ready");
  });
});

test("quiesce fences new work, removes only empty pointers, and awaits child exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "acp-quiesce-"));
  for (const id of [threadA, threadB]) await mkdir(join(root, id, "repo"), { recursive: true });
  await writeFile(join(root, "authenticated"), "synthetic");
  let release;
  let authStopped = false;
  const checkpoint = { sync: () => authStopped ? Promise.resolve() : new Promise((resolve) => { release = resolve; }), stop: () => { authStopped = true; } };
  const bridge = createUserBridge({ command: [process.execPath, fake, "shared", "slow-exit"], root, authCheckpoint: checkpoint });
  try {
    const empty = await bridge.session(threadA);
    const completed = await bridge.session(threadB);
    await Promise.all([empty.ready, completed.ready]);
    await completed.act({ type: "prompt", text: "inspect", requestId: "completed" });
    await until(() => completed.snapshot.permissions.length === 1);
    await completed.act({ type: "permission", id: completed.snapshot.permissions[0].id, optionId: "deny" });
    await until(() => completed.snapshot.status === "ready");
    const stopping = bridge.quiesce();
    await until(() => Boolean(release));
    await expect(completed.act({ type: "set-config", configId: "model", value: "large" })).rejects.toThrow();
    await expect(bridge.session("33333333-3333-4333-8333-333333333333")).rejects.toThrow();
    release();
    expect(await stopping).toBe(true);
    expect(authStopped).toBe(true);
    await expect(access(join(root, threadA, "acp-session"))).rejects.toThrow();
    await access(join(root, threadB, "acp-session"));
    await access(join(root, "child-exited"));
    expect(bridge.isAlive()).toBe(false);
    expect(await bridge.quiesce()).toBe(true);
    expect(completed.snapshot.messages.some((m) => m.role === "assistant")).toBe(true);
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("quiesce preserves a loaded session even without a new turn", async () => {
  await sharedFixture(true, async (bridge, root) => {
    const pointer = join(root, threadA, "acp-session");
    await writeFile(pointer, `session-${threadA}`);
    const a = await bridge.session(threadA);
    await a.ready;
    expect(a.snapshot.messages.map((m) => m.text)).toEqual(["previous task", "restored answer"]);
    expect(await bridge.quiesce()).toBe(true);
    expect(await readFile(pointer, "utf8")).toBe(`session-${threadA}`);
  });
});

test("checkpoint callbacks never overlap and retry after errors", async () => {
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  let release;
  const loop = createCheckpointLoop({
    url: "https://callback.invalid/checkpoint",
    token: "secret",
    payload: () => ({ activity: {} }),
    interval: 60_000,
    fetcher: async (_url, init) => {
      calls++; active++; maxActive = Math.max(maxActive, active);
      expect(init.headers.Authorization).toBe("Bearer secret");
      if (calls === 1) await new Promise((resolve) => { release = resolve; });
      active--;
      if (calls === 2) throw new Error("temporary");
      return new Response(null, { status: 204 });
    },
  });
  const first = loop.run();
  await until(() => Boolean(release));
  const joined = loop.run();
  release();
  await Promise.all([first, joined]);
  await loop.run(); // failed callback is swallowed
  await loop.run(); // and can retry
  loop.stop();
  expect(calls).toBe(3);
  expect(maxActive).toBe(1);
});

test("checkpoint loop pauses only after a successful idle save and re-arms for new work", async () => {
  let calls = 0;
  const loop = createCheckpointLoop({
    url: "https://callback.invalid/checkpoint", token: "synthetic",
    payload: () => ({}), shouldContinue: () => false, interval: 10, debounce: 1,
    fetcher: async () => Response.json({ saved: ++calls > 1 }),
  });
  try {
    await until(() => calls === 2);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls).toBe(2); // first pending save retried; successful idle save paused
    loop.settled();
    await until(() => calls === 3);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls).toBe(3);
  } finally { loop.stop(); }
});
