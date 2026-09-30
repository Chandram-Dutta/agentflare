import { expect, test } from "bun:test";
import { ThreadStateStore, activityLabel } from "./thread-state";
import type { AcpSnapshot } from "./acp";
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
  return new ThreadStateStore(request as typeof apiRequest);
}

test("switching shares an in-flight connect and retains isolated drafts and snapshots", async () => {
  const connect = deferred<AcpSnapshot>();
  const calls: string[] = [];
  const store = storeWith(async (path, method) => {
    calls.push(`${method}:${path}`);
    return path.endsWith("/status") ? runtime : connect.promise;
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
    "POST:/threads/a/runtime/acp",
  ]);
  expect(store.get("a")).toMatchObject({
    draft: "unfinished A",
    scroll: 125,
    snapshot: ready,
  });
  expect(store.get("b").draft).toBe("different B");
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
  expect(activityLabel(store.get("a"))).toBe("needs attention");
  attention = false;
  await store.pollActivity();
  expect(activityLabel(store.get("a"))).toBe("running");
  status = "ready";
  await store.pollActivity();
  expect(activityLabel(store.get("a"))).toBe("finished");
  expect(store.get("b").unread).toBe(false);
  store.select("a", false);
  await store.pollActivity();
  expect(activityLabel(store.get("a"))).toBe("finished");
  store.select("a");
  await store.pollActivity();
  expect(activityLabel(store.get("a"))).toBe("ready");
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
  expect(activityLabel(store.get("a"))).toBe("running");
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
  expect(activityLabel(store.get("a"), store.activityError)).toBe("running");
  exists = false;
  await store.pollActivity();
  expect(activityLabel(store.get("a"))).toBe("not connected");
  expect(store.get("a").unread).toBe(false);
});
