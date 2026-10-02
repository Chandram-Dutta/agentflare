import { afterEach, expect, spyOn, test } from "bun:test";
import { publishSnapshot, type PublishState } from "./publish";

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
afterEach(() => fetchSpy?.mockRestore());
const base = "a".repeat(40),
  tree = "b".repeat(40),
  blob = "c".repeat(40),
  next = "d".repeat(40);
const input = {
  repository: "https://github.com/owner/repo",
  branch: "agentflare/thread",
  baseBranch: "main",
  baseSha: base,
  revision: tree,
  title: "Fix behavior",
  body: "Tested locally",
  token: "test-token",
  snapshot: {
    branch: "agentflare/thread",
    revision: tree,
    entries: [{ path: "new.txt", mode: "100644", type: "blob", sha: blob }],
    blobs: { [blob]: "aGVsbG8=" },
  },
};

test("publish creates a complete snapshot and draft PR; retry after uncertain ref write reuses commit", async () => {
  let state: PublishState = {};
  let head: string | undefined;
  let uncertain = true;
  const writes: {
    path: string;
    method: string;
    body: Record<string, unknown>;
  }[] = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    url,
    init,
  ) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== "GET") writes.push({ path, method, body });
    if (path.endsWith("/pulls") && method === "GET") return Response.json([]);
    if (path.includes("/git/ref/"))
      return head
        ? Response.json({ object: { sha: head } })
        : new Response(null, { status: 404 });
    if (path.includes("/git/commits/"))
      return Response.json({ tree: { sha: head ? tree : "e".repeat(40) } });
    if (path.endsWith("/git/blobs")) return Response.json({ sha: blob });
    if (path.endsWith("/git/trees")) return Response.json({ sha: tree });
    if (path.endsWith("/git/commits")) return Response.json({ sha: next });
    if (path.endsWith("/git/refs")) {
      // The intent must be durable BEFORE GitHub sees the ref mutation.
      expect(state.prepared?.sha).toBe(next);
      head = next;
      if (uncertain) {
        uncertain = false;
        throw Error("connection lost after write");
      }
    }
    if (path.endsWith("/pulls"))
      return Response.json({
        number: 12,
        html_url: "https://github.com/owner/repo/pull/12",
      });
    throw Error(`Unexpected request ${method} ${path}`);
  }) as typeof fetch);
  const run = () =>
    publishSnapshot({
      ...input,
      state,
      save: async (value) => {
        state = structuredClone(value);
      },
    });
  await expect(run()).rejects.toThrow("connection lost");
  expect(state.head).toBeUndefined();
  expect((await run()).number).toBe(12);
  expect(writes.filter((w) => w.path.endsWith("/git/commits"))).toHaveLength(1);
  expect(writes.filter((w) => w.path.endsWith("/git/refs"))).toHaveLength(1);
  expect(writes.find((w) => w.path.endsWith("/git/trees"))!.body).toEqual({
    tree: input.snapshot.entries,
  });
  expect(writes.find((w) => w.path.endsWith("/git/commits"))!.body).toEqual({
    message: input.title,
    tree,
    parents: [base],
  });
  expect(writes.find((w) => w.path.endsWith("/pulls"))!.body).toMatchObject({
    head: input.branch,
    base: "main",
    draft: true,
  });
  expect(state.result?.sha).toBe(next);
  expect(state.result?.revision).toBe(tree);
});

test("stale review and branch switches cannot invoke GitHub; foreign remote heads cannot be overwritten", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(Response.json([]));
  const save = async () => {};
  await expect(
    publishSnapshot({ ...input, revision: base, state: {}, save }),
  ).rejects.toThrow("checkout changed");
  await expect(
    publishSnapshot({ ...input, branch: "main", state: {}, save }),
  ).rejects.toThrow("checkout changed");
  expect(fetchSpy).toHaveBeenCalledTimes(0);
  fetchSpy
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(Response.json({ object: { sha: "f".repeat(40) } }));
  await expect(
    publishSnapshot({ ...input, state: { head: next }, save }),
  ).rejects.toThrow("outside Agentflare");
  expect(fetchSpy.mock.calls.every(([, init]) => init?.method === "GET")).toBe(
    true,
  );
});

test("updates append to the known published head without force and reuse the existing PR", async () => {
  const calls: { method?: string; body?: unknown; path: string }[] = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    url,
    init,
  ) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method, body, path });
    if (path.endsWith("/pulls"))
      return Response.json([
        {
          number: 4,
          html_url: "https://github.com/owner/repo/pull/4",
          state: "open",
          base: { ref: "main" },
        },
      ]);
    if (path.includes("/git/ref/"))
      return Response.json({ object: { sha: base } });
    if (path.includes("/git/commits/"))
      return Response.json({ tree: { sha: "e".repeat(40) } });
    if (path.endsWith("/git/blobs")) return Response.json({ sha: blob });
    if (path.endsWith("/git/trees")) return Response.json({ sha: tree });
    if (path.endsWith("/git/commits")) return Response.json({ sha: next });
    if (init?.method === "PATCH")
      return Response.json({ object: { sha: next } });
    throw Error("Unexpected request");
  }) as typeof fetch);
  const result = await publishSnapshot({
    ...input,
    state: { head: base },
    save: async () => {},
  });
  expect(result.number).toBe(4);
  expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({
    sha: next,
    force: false,
  });
  expect(calls.filter((call) => call.path.endsWith("/pulls"))).toHaveLength(1);
});
