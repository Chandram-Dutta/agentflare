import { expect, test } from "bun:test";
import {
  loadBranchDiffs,
  patchKind,
  type DiffResult,
} from "./branch-diff-review-loader";

function harness(paths = ["a", "b", "c", "d", "e", "f"]) {
  const requests: {
    url: string;
    signal: AbortSignal;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const events: [string, DiffResult][] = [];
  const loader = loadBranchDiffs(
    "/runtime/test",
    paths,
    (path, result) => events.push([path, result]),
    (url, signal) =>
      new Promise((resolve, reject) =>
        requests.push({ url, signal, resolve, reject }),
      ),
  );
  return { requests, events, loader };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("live diffs from a different tree or without revision evidence cannot be reviewed", async () => {
  for (const revision of [undefined, "new-tree"]) {
    const events: DiffResult[] = [];
    loadBranchDiffs(
      "/runtime",
      ["file"],
      (_, result) => events.push(result),
      async () => ({ patch: "+not the reviewed tree", revision }),
      "expected-tree",
    );
    await tick();
    expect(events.at(-1)).toEqual({
      state: "error",
      message: "The checkout changed. Refresh the review before continuing.",
    });
  }
  const events: DiffResult[] = [];
  loadBranchDiffs(
    "/runtime",
    ["file"],
    (_, result) => events.push(result),
    async () => ({ patch: "+exact", revision: "expected-tree" }),
    "expected-tree",
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(events.at(-1)).toMatchObject({
    state: "ready",
    patch: "+exact",
    fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
});

test("four concurrent requests; out-of-order results publish progressively and release one slot", async () => {
  const { requests, events, loader } = harness();
  expect(requests).toHaveLength(4);
  requests[2].resolve({ patch: "third" });
  await tick();
  expect(events).toContainEqual(["c", { state: "ready", patch: "third" }]);
  expect(requests).toHaveLength(5);
  expect(
    events.some(([path, result]) => path === "a" && result.state === "ready"),
  ).toBe(false);
  requests[0].resolve({ patch: "first" });
  await tick();
  expect(requests).toHaveLength(6);
  loader.cancel();
});

test("retry stays bounded, repeated retry is deduplicated, and success clears failure", async () => {
  const { requests, events, loader } = harness();
  requests[0].reject(new Error("offline"));
  await tick();
  expect(events).toContainEqual(["a", { state: "error", message: "offline" }]);
  expect(requests).toHaveLength(5);
  loader.retry("a");
  loader.retry("a");
  loader.retry("unknown");
  expect(requests).toHaveLength(5);
  requests[1].resolve({ patch: "" });
  await tick();
  expect(requests).toHaveLength(6);
  requests[2].resolve({ patch: "c" });
  await tick();
  expect(requests).toHaveLength(7);
  expect(requests[6].url).toEndWith("path=a");
  requests[6].resolve({ patch: "recovered" });
  await tick();
  expect(events.at(-1)).toEqual(["a", { state: "ready", patch: "recovered" }]);
  loader.retry("a");
  expect(requests).toHaveLength(7);
  loader.cancel();
});

test("cancel aborts active work, suppresses late success AND failure, and never starts queued work", async () => {
  const { requests, events, loader } = harness();
  loader.cancel();
  const before = [...events];
  expect(requests.every((request) => request.signal.aborted)).toBe(true);
  requests[0].resolve({ patch: "stale" });
  requests[1].reject(new Error("late"));
  await tick();
  loader.retry("a");
  expect(events).toEqual(before);
  expect(requests).toHaveLength(4);
});

test("a replacement review cannot receive a stale response for the same path", async () => {
  const old = harness(["a"]);
  old.loader.cancel();
  const next = harness(["a"]);
  next.requests[0].resolve({ patch: "new revision" });
  old.requests[0].resolve({ patch: "old revision" });
  await tick();
  expect(old.events).toEqual([["a", { state: "loading" }]]);
  expect(next.events.at(-1)).toEqual([
    "a",
    { state: "ready", patch: "new revision" },
  ]);
  next.loader.cancel();
});

test("empty patches are valid, invalid response shapes are errors, paths are encoded and deduplicated", async () => {
  const { requests, events, loader } = harness([
    "a #&?.ts",
    "a #&?.ts",
    "constructor",
    "__proto__",
    "bad",
  ]);
  expect(requests).toHaveLength(4);
  expect(requests[0].url).toBe(
    "/runtime/test/branch-diff?path=a%20%23%26%3F.ts",
  );
  requests[0].resolve({ patch: "" });
  requests[1].resolve(null);
  requests[2].resolve({ content: "not a patch" });
  requests[3].resolve({ patch: 12 });
  await tick();
  expect(events).toContainEqual(["a #&?.ts", { state: "ready", patch: "" }]);
  expect(events.filter(([, result]) => result.state === "error")).toHaveLength(
    3,
  );
  loader.cancel();
  expect(harness([]).requests).toHaveLength(0);
});

test("classification distinguishes zero-line additions, deletions, binary, metadata and absent patches", () => {
  expect(patchKind(" \n")).toBe("empty");
  expect(
    patchKind(
      "diff --git a/x b/x\nnew file mode 100644\nindex 0000000..e69de29\n",
    ),
  ).toBe("metadata");
  expect(
    patchKind("diff --git a/x b/x\nold mode 100644\nnew mode 100755\n"),
  ).toBe("metadata");
  expect(patchKind("Binary files /dev/null and b/image.png differ\n")).toBe(
    "binary",
  );
  expect(patchKind("GIT binary patch\nliteral 2\n")).toBe("binary");
  expect(patchKind("@@ -0,0 +1,2 @@\n+one\n+two\n")).toBe("text");
  expect(patchKind("@@ -1 +0,0 @@\n-old\n")).toBe("text");
  expect(
    patchKind("@@ -1 +1 @@\n-Binary files a and b differ\n+GIT binary patch\n"),
  ).toBe("text");
});
