import { expect, test } from "bun:test";
import { ThreadStateStore, activityLabel, attentionKind } from "./thread-state";
import type { AcpSnapshot, AcpActivity } from "./acp";
import type { ThreadNotification } from "./thread-notifications";
import type { apiRequest } from "./api-client";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const ready: AcpSnapshot = { status: "ready", messages: [], permissions: [] };
const running: AcpSnapshot = {
  ...ready,
  status: "running",
  messages: [{ id: "turn-1", role: "user", text: "task" }],
};
const runtime = { started: true, agent: "codex" as const };
function storeWith(
  request: (...args: Parameters<typeof apiRequest>) => Promise<unknown>,
) {
  return new ThreadStateStore((async (
    ...args: Parameters<typeof apiRequest>
  ) => {
    const value = await request(...args);
    return args[0].includes("transport=delta")
      ? { revision: crypto.randomUUID(), snapshot: value }
      : value;
  }) as typeof apiRequest);
}

test("a message restores a sleeping native workspace once and preserves the draft on failure", async () => {
  const response = deferred<AcpSnapshot>();
  const calls: string[] = [];
  const store = storeWith(async (_path, method) => {
    calls.push(method ?? "GET");
    return response.promise;
  });
  store.update("a", {
    runtime: { ...runtime, autoResume: true },
    snapshot: { ...ready, saved: true, workspace: "suspended" },
    draft: "continue",
  });
  const sending = store.action("a", {
    type: "prompt",
    text: "continue",
    requestId: "new-turn",
  });
  expect(store.get("a").snapshot?.workspace).toBe("recovering");
  expect(store.get("a").draft).toBe("continue");
  response.resolve({ ...ready, workspace: "running" });
  expect(await sending).toBe(true);
  expect(calls).toEqual(["POST"]);
  expect(store.get("a").draft).toBe("");

  const failedCalls: string[] = [];
  const failed = storeWith(async (_path, method) => {
    failedCalls.push(method ?? "GET");
    if (method === "POST") throw Error("Restore failed");
    return { ...ready, workspace: "failed" };
  });
  failed.update("a", {
    runtime: { ...runtime, autoResume: true },
    snapshot: { ...ready, saved: true, workspace: "suspended" },
    draft: "continue",
  });
  expect(
    await failed.action("a", {
      type: "prompt",
      text: "continue",
      requestId: "new-turn",
    }),
  ).toBe(false);
  expect(failedCalls).toEqual(["POST", "GET"]);
  expect(failed.get("a").snapshot?.workspace).toBe("failed");
  expect(failed.get("a").draft).toBe("continue");
});

test("accepted rich sends clear submitted attachments and preserve newer attachments", async () => {
  const response = deferred<AcpSnapshot>();
  const store = storeWith(async () => response.promise);
  const attachments = [
    { type: "image" as const, mimeType: "image/png", data: "aGk=" },
  ];
  store.update("a", { draft: "", attachments });
  const sending = store.action("a", {
    type: "prompt",
    text: "",
    requestId: "image",
    attachments,
  });
  const newer = [{ type: "text" as const, text: "new context" }];
  store.update("a", { attachments: newer });
  response.resolve(running);
  await sending;
  expect(store.get("a").attachments).toBe(newer);
  await store.action("a", {
    type: "prompt",
    text: "",
    requestId: "new",
    attachments: newer,
  });
  expect(store.get("a").attachments).toBeUndefined();
});

test("switching shares an in-flight connect and retains isolated drafts and snapshots", async () => {
  const connect = deferred<AcpSnapshot>();
  const calls: string[] = [];
  const store = storeWith(async (path, method) => {
    calls.push(`${method}:${path}`);
    if (path.endsWith("/status")) return runtime;
    if (path.endsWith("/saved")) return null;
    return connect.promise;
  });
  store.select("a");
  const first = store.ensure("a");
  store.update("a", { draft: "unfinished A", scroll: 125 });
  store.select("b");
  store.update("b", { draft: "different B" });
  store.select("a");
  const second = store.ensure("a");
  connect.resolve(ready);
  await Promise.all([first, second]);
  await store.ensure("a");
  expect(calls).toEqual([
    "GET:/threads/a/runtime/status",
    "GET:/threads/a/runtime/saved",
    "POST:/threads/a/runtime/acp",
    "GET:/threads/a/runtime/acp?transport=delta",
  ]);
  expect(store.get("a")).toMatchObject({
    draft: "unfinished A",
    scroll: 125,
    snapshot: ready,
  });
  expect(store.get("b").draft).toBe("different B");
});

test("saved history is shown without connecting or polling until resume", async () => {
  const saved: AcpSnapshot = {
    ...ready,
    saved: true,
    messages: [{ id: "old", role: "assistant", text: "saved result" }],
  };
  const calls: string[] = [];
  const store = storeWith(async (path) => {
    calls.push(path);
    return path.endsWith("/status") ? runtime : saved;
  });
  await store.ensure("a");
  await store.pollConversation("a");
  expect(store.get("a").snapshot).toEqual(saved);
  expect(calls).toEqual([
    "/threads/a/runtime/status",
    "/threads/a/runtime/saved",
  ]);
});

test("stopped Computers stay asleep until explicit resume, and observe another client's resume", async () => {
  const calls: string[] = [];
  const suspended: AcpSnapshot = {
    ...ready,
    saved: true,
    workspace: "suspended",
  };
  const store = storeWith(async (path, method) => {
    calls.push(`${method}:${path}`);
    if (path.endsWith("/status")) return { ...runtime, workspace: "suspended" };
    if (path.endsWith("/saved")) return suspended;
    return { ...ready, workspace: "running" };
  });
  await store.ensure("a");
  await store.pollConversation("a");
  expect(calls).toHaveLength(2);
  expect(activityLabel(store.get("a"))).toBe("suspended");
  store.update("a", {
    activity: { status: "ready", attention: false, workspace: "running" },
  });
  await store.pollConversation("a");
  expect(calls.at(-1)).toBe("GET:/threads/a/runtime/acp?transport=delta");
  expect(store.get("a").snapshot?.workspace).toBe("running");
  expect(calls.some((call) => call.startsWith("POST:"))).toBe(false);
});

test("failed suspend restores the current view, exposes the error, and keeps the draft", async () => {
  const response = deferred<AcpSnapshot>();
  const store = storeWith(async () => {
    await response.promise;
    throw Error("Workspace archive failed.");
  });
  const snapshot: AcpSnapshot = { ...ready, workspace: "running" };
  store.update("a", { runtime, snapshot, draft: "keep this" });
  const saving = store.action("a", { type: "suspend" });
  expect(activityLabel(store.get("a"))).toBe("saving");
  expect(store.get("a").snapshot?.persistence?.state).toBe("saving");
  response.resolve(ready);
  await saving;
  expect(store.get("a")).toMatchObject({
    snapshot,
    draft: "keep this",
    pending: false,
    error: "Workspace archive failed.",
  });
});

test("failed suspension reads the server state instead of advertising the old running workspace", async () => {
  const calls: string[] = [];
  const failed: AcpSnapshot = {
    ...ready,
    workspace: "failed",
    interrupted: true,
  };
  const store = storeWith(async (path, method) => {
    calls.push(`${method}:${path}`);
    if (method === "POST") throw Error("Save failed after stopping Codex");
    return failed;
  });
  store.update("a", {
    runtime,
    snapshot: { ...ready, workspace: "running" },
    draft: "keep my draft",
  });
  expect(await store.action("a", { type: "suspend" })).toBe(false);
  expect(store.get("a")).toMatchObject({
    snapshot: failed,
    draft: "keep my draft",
    pending: false,
    activity: { workspace: "failed" },
  });
  expect(calls).toEqual([
    "POST:/threads/a/runtime/acp",
    "GET:/threads/a/runtime/acp",
  ]);
});

test("switching while saved-history requests overlap keeps responses isolated", async () => {
  const savedA = deferred<AcpSnapshot | null>();
  const savedB = deferred<AcpSnapshot | null>();
  const store = storeWith(async (path) => {
    if (path.endsWith("/status")) return runtime;
    return path.includes("/a/") ? savedA.promise : savedB.promise;
  });
  store.select("a");
  const loadingA = store.ensure("a");
  store.select("b");
  const loadingB = store.ensure("b");
  savedB.resolve({
    ...ready,
    saved: true,
    messages: [{ id: "b", role: "assistant", text: "B" }],
  });
  await loadingB;
  savedA.resolve({
    ...ready,
    saved: true,
    messages: [{ id: "a", role: "assistant", text: "A" }],
  });
  await loadingA;
  expect(store.get("a").snapshot?.messages[0]?.text).toBe("A");
  expect(store.get("b").snapshot?.messages[0]?.text).toBe("B");
});

test("resume clears saved state and preserves history until ACP replay arrives", async () => {
  const history = [{ id: "old", role: "assistant" as const, text: "result" }];
  const response = deferred<AcpSnapshot>();
  const store = storeWith(async () => response.promise);
  store.update("a", {
    runtime,
    hydrated: true,
    snapshot: { ...ready, saved: true, messages: history },
  });
  const resuming = store.action("a", { type: "connect" });
  expect(store.get("a").snapshot).toMatchObject({
    saved: false,
    messages: history,
  });
  response.resolve(ready);
  expect(await resuming).toBe(true);
  expect(store.get("a").snapshot?.messages).toEqual(history);
  expect(store.get("a").snapshot?.saved).toBeUndefined();
});

test("an old GET cannot overwrite a newer prompt action, even after switching", async () => {
  const old = deferred<AcpSnapshot>();
  const store = storeWith(async (_path, method) =>
    method === "POST" ? running : old.promise,
  );
  store.update("a", { runtime, snapshot: ready, draft: "task" });
  const polling = store.pollConversation("a");
  store.select("b");
  await store.action("a", {
    type: "prompt",
    text: "task",
    requestId: "turn-1",
  });
  old.resolve(ready);
  await polling;
  expect(store.get("a").snapshot?.status).toBe("running");
  expect(store.get("a").draft).toBe("");
  expect(store.get("b").snapshot).toBeUndefined();
});

test("accepted sends do not erase a newer draft and duplicate clicks do not send twice", async () => {
  const response = deferred<AcpSnapshot>();
  let calls = 0;
  const store = storeWith(async () => {
    calls++;
    return response.promise;
  });
  store.update("a", { draft: "task" });
  const action = { type: "prompt" as const, text: "task", requestId: "turn-1" };
  const sending = store.action("a", action);
  expect(await store.action("a", action)).toBe(false);
  store.update("a", { draft: "next task" });
  response.resolve(running);
  await sending;
  expect(calls).toBe(1);
  expect(store.get("a").draft).toBe("next task");
});

test("background completion and permissions are discovered without connecting threads", async () => {
  let status: "running" | "ready" = "running";
  let attention = true;
  const calls: string[] = [];
  const store = storeWith(async (path) => {
    calls.push(path);
    return {
      a: { status, attention, turn: "t1" },
      b: { status: "ready", attention: false },
    };
  });
  store.select("b");
  await store.pollActivity();
  expect(activityLabel(store.get("a"))).toBe("waiting for user");
  attention = false;
  await store.pollActivity();
  expect(activityLabel(store.get("a"))).toBe("working");
  status = "ready";
  await store.pollActivity();
  expect(activityLabel(store.get("a"))).toBe("finished");
  expect(store.get("b").unread).toBe(false);
  store.select("a", false);
  await store.pollActivity();
  expect(activityLabel(store.get("a"))).toBe("finished");
  store.select("a");
  await store.pollActivity();
  expect(activityLabel(store.get("a"))).toBe("finished");
  expect(attentionKind(store.get("a"))).toBeUndefined();
  expect(calls.every((path) => path === "/activity")).toBe(true);
  expect(store.get("a").runtime).toBeUndefined();
});

test("stale activity cannot regress a newer snapshot or resurrect a deleted thread", async () => {
  const response = deferred<unknown>();
  const store = storeWith(async (_path, method) =>
    method === "POST" ? running : response.promise,
  );
  const poll = store.pollActivity();
  await store.action("a", {
    type: "prompt",
    text: "task",
    requestId: "turn-1",
  });
  store.forget("b");
  response.resolve({
    a: { status: "ready", attention: false },
    b: { status: "running", attention: false },
  });
  await poll;
  expect(activityLabel(store.get("a"))).toBe("working");
  expect(store.get("b").activity).toBeUndefined();
  await store.pollActivity();
  expect(store.get("b").activity).toBeUndefined();
});

test("deletion fences a pending connect response", async () => {
  const response = deferred<AcpSnapshot>();
  const store = storeWith(async () => response.promise);
  const action = store.action("a", { type: "connect" });
  store.forget("a");
  response.resolve(ready);
  expect(await action).toBe(false);
  expect(store.get("a").snapshot).toBeUndefined();
  expect(store.get("a").pending).toBe(false);
});

test("failed activity is unknown, retries recover, and a lost bridge is not completion", async () => {
  let fail = false;
  let exists = true;
  const store = storeWith(async () => {
    if (fail) throw Error("offline");
    return exists
      ? { a: { status: "running", attention: false, turn: "t1" } }
      : {};
  });
  await store.pollActivity();
  fail = true;
  await store.pollActivity();
  expect(activityLabel(store.get("a"), store.activityError)).toBe("unknown");
  fail = false;
  await store.pollActivity();
  expect(activityLabel(store.get("a"), store.activityError)).toBe("working");
  exists = false;
  await store.pollActivity();
  expect(activityLabel(store.get("a"))).toBe("not connected");
  expect(store.get("a").unread).toBe(false);
});

test("notifications baseline old activity, deduplicate turns, and track successive approvals", async () => {
  let activity: Record<string, AcpActivity> = {
    a: { status: "ready", attention: false, turn: "old" },
    b: {
      status: "running",
      attention: true,
      turn: "t1",
      attentionId: "old-approval",
    },
  };
  const store = storeWith(async () => activity);
  store.setNotificationsEnabled(true);
  const events: ThreadNotification[] = [];
  const unsubscribe = store.subscribeNotifications((event) =>
    events.push(event),
  );
  await store.pollActivity();
  expect(events).toEqual([]);
  activity.a = { status: "running", attention: false, turn: "t2" };
  await store.pollActivity();
  activity.a = { ...activity.a, status: "ready" };
  await store.pollActivity();
  await store.pollActivity();
  // Replaying a running snapshot for an already settled turn doesn't re-notify.
  activity.a = { ...activity.a, status: "running" };
  await store.pollActivity();
  activity.a = { ...activity.a, status: "ready" };
  await store.pollActivity();
  expect(events).toEqual([{ threadId: "a", kind: "finished" }]);
  activity.b = { ...activity.b, attentionId: "new-approval" };
  await store.pollActivity();
  await store.pollActivity();
  expect(events.at(-1)).toEqual({ threadId: "b", kind: "attention" });
  expect(events).toHaveLength(2);
  store.setNotificationsEnabled(false);
  activity.a = { ...activity.a, turn: "t3" };
  await store.pollActivity();
  store.setNotificationsEnabled(true);
  await store.pollActivity();
  expect(events).toHaveLength(2);
  unsubscribe();
  activity.a = { ...activity.a, turn: "t4" };
  await store.pollActivity();
  expect(events).toHaveLength(2);
  activity = {};
  await store.pollActivity();
});

test("a stopped turn and a deleted thread don't send completion notifications", async () => {
  let activity: Record<string, AcpActivity> = {
    a: { status: "running", attention: false, turn: "turn-1" },
  };
  const store = storeWith(async (_path, method) =>
    method === "POST"
      ? { ...running, status: "ready", turnCancelled: true }
      : activity,
  );
  store.setNotificationsEnabled(true);
  const events: ThreadNotification[] = [];
  store.subscribeNotifications((event) => events.push(event));
  await store.pollActivity();
  await store.action("a", { type: "cancel" });
  expect(events).toEqual([]);
  store.forget("a");
  activity = { a: { status: "ready", attention: false, turn: "new" } };
  await store.pollActivity();
  expect(events).toEqual([]);
});

test("loading a saved transcript cannot notify for historical completion over live activity", async () => {
  for (const status of ["running", "ready"] as const) {
    const store = storeWith(async (path) => {
      if (path === "/activity")
        return { a: { status, attention: false, turn: "current" } };
      if (path.endsWith("/status")) return runtime;
      return {
        ...ready,
        saved: true,
        messages: [{ id: "historical", role: "user", text: "old task" }],
      };
    });
    store.setNotificationsEnabled(true);
    const events: ThreadNotification[] = [];
    store.subscribeNotifications((event) => events.push(event));
    await store.pollActivity();
    await store.ensure("a");
    expect(store.get("a").snapshot?.saved).toBe(true);
    expect(store.get("a").activity).toMatchObject({ status, turn: "current" });
    await store.pollActivity();
    expect(events).toEqual([]);
  }
});

test("another client's cancelled turn does not notify, but its next completed turn does", async () => {
  let activity: AcpActivity = {
    status: "running",
    attention: false,
    turn: "cancelled",
  };
  const store = storeWith(async () => ({ a: activity }));
  store.setNotificationsEnabled(true);
  const events: ThreadNotification[] = [];
  store.subscribeNotifications((event) => events.push(event));
  await store.pollActivity();
  activity = { ...activity, status: "ready", turnCancelled: true };
  await store.pollActivity();
  expect(events).toEqual([]);
  expect(store.get("a").unread).toBe(false);
  activity = { status: "ready", attention: false, turn: "completed" };
  await store.pollActivity();
  await store.pollActivity();
  expect(events).toEqual([{ threadId: "a", kind: "finished" }]);
});

test("cached views remain synchronous while refreshes race; the newest response wins", async () => {
  const first = deferred<AcpSnapshot>();
  const second = deferred<AcpSnapshot>();
  let calls = 0;
  const store = storeWith(async () =>
    ++calls === 1 ? first.promise : second.promise,
  );
  const repository = {
    files: ["a.ts"],
    changes: [],
    tab: "files",
    view: { path: "a.ts", label: "a.ts", content: "cached source" },
  };
  store.update("a", { runtime, hydrated: true, snapshot: running, repository });
  const old = store.ensure("a");
  store.select("b");
  store.select("a");
  const recent = store.ensure("a");
  expect(store.get("a").snapshot).toBe(running);
  expect(store.get("a").repository).toBe(repository);
  second.resolve({ ...running, status: "ready" });
  await recent;
  first.resolve(running);
  await old;
  expect(activityLabel(store.get("a"))).toBe("finished");
  expect(store.get("a").repository).toBe(repository);
});

test("a late activity failure cannot replace a newer successful observation", async () => {
  const gate = deferred<void>();
  let calls = 0;
  const store = storeWith(async () => {
    if (++calls === 1) {
      await gate.promise;
      throw Error("old network failure");
    }
    return { a: { status: "running", attention: true, attentionId: "p1" } };
  });
  const old = store.pollActivity();
  await store.pollActivity();
  gate.resolve();
  await old;
  expect(store.activityError).toBe(false);
  expect(attentionKind(store.get("a"))).toBe("approval");
});

test("checkpoint saves without suspension and recovers truth after failure without replay", async () => {
  const gate = deferred<void>();
  const calls: string[] = [];
  const failed: AcpSnapshot = {
    ...running,
    workspace: "running",
    persistence: { state: "error" },
  };
  const store = storeWith(async (path, method) => {
    calls.push(`${method}:${path}`);
    if (method === "POST") {
      await gate.promise;
      throw Error("Checkpoint upload failed");
    }
    return failed;
  });
  store.update("a", {
    runtime,
    snapshot: { ...running, workspace: "running" },
    draft: "next instruction",
  });
  const saving = store.action("a", { type: "checkpoint" });
  expect(activityLabel(store.get("a"))).toBe("saving");
  expect(store.get("a").snapshot?.workspace).toBe("running");
  gate.resolve();
  expect(await saving).toBe(false);
  expect(store.get("a").snapshot).toEqual(failed);
  expect(store.get("a").draft).toBe("next instruction");
  expect(attentionKind(store.get("a"))).toBe("failure");
  expect(calls).toEqual([
    "POST:/threads/a/runtime/acp",
    "GET:/threads/a/runtime/acp",
  ]);
});

test("transport cursor resets after stale deltas and actions, without losing display history", async () => {
  const paths: string[] = [];
  const responses: unknown[] = [
    { revision: "r1", snapshot: running },
    { revision: "r3", base: "wrong", start: 0, remove: 0, insert: "" },
    { revision: "r4", snapshot: { ...running, status: "ready" } },
    running,
    { revision: "r5", snapshot: running },
  ];
  const store = new ThreadStateStore((async (path: string) => {
    paths.push(path);
    return responses.shift();
  }) as typeof apiRequest);
  store.update("a", { runtime, snapshot: ready });
  await store.pollConversation("a");
  await store.pollConversation("a");
  expect(store.get("a").snapshot).toBe(running);
  expect(store.get("a").error).toContain("Stale conversation");
  await store.pollConversation("a");
  await store.action("a", { type: "prompt", requestId: "next", text: "next" });
  await store.pollConversation("a");
  expect(paths).toEqual([
    "/threads/a/runtime/acp?transport=delta",
    "/threads/a/runtime/acp?transport=delta&revision=r1",
    "/threads/a/runtime/acp?transport=delta",
    "/threads/a/runtime/acp",
    "/threads/a/runtime/acp?transport=delta",
  ]);
  expect(store.get("a").error).toBe("");
});

test("late conversation reads cannot regress background completion or re-add acknowledged results", async () => {
  const old = deferred<AcpSnapshot>();
  let activity: AcpActivity = {
    status: "running",
    attention: false,
    turn: "turn-1",
  };
  const store = storeWith(async (path) =>
    path === "/activity" ? { a: activity } : old.promise,
  );
  store.update("a", { runtime, snapshot: running });
  await store.pollActivity();
  const reading = store.pollConversation("a");
  activity = { ...activity, status: "ready" };
  await store.pollActivity();
  old.resolve(running);
  await reading;
  expect(activityLabel(store.get("a"))).toBe("finished");
  expect(attentionKind(store.get("a"))).toBe("finished");
  store.select("a");
  store.select("b");
  activity = { ...activity, status: "running" };
  await store.pollActivity();
  activity = { ...activity, status: "ready" };
  await store.pollActivity();
  expect(attentionKind(store.get("a"))).toBeUndefined();
});
