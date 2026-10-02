import { expect, test } from "bun:test";
import {
  CONTEXT_LIMIT,
  fileContext,
  RepositoryViewer,
} from "./repository-viewer";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("out-of-order reads fill distinct tabs without stealing focus or duplicating requests", async () => {
  const a = deferred<{ content: string }>();
  const b = deferred<{ content: string }>();
  const calls: string[] = [];
  const viewer = new RepositoryViewer(undefined, (path) => {
    calls.push(path);
    return path === "a.ts" ? a.promise : b.promise;
  });
  viewer.open({ path: "a.ts" });
  viewer.open({ path: "a.ts", startLine: 12, endLine: 14 });
  viewer.open({ path: "b.ts" });
  const refreshing = viewer.refresh();
  b.resolve({ content: "beta" });
  await viewer.load("b.ts");
  expect(viewer.getSnapshot().active).toBe("b.ts");
  a.resolve({ content: "alpha" });
  await refreshing;
  expect(calls).toEqual(["a.ts", "b.ts"]);
  expect(viewer.getSnapshot().paths).toEqual(["a.ts", "b.ts"]);
  expect(viewer.getSnapshot().active).toBe("b.ts");
  expect(viewer.getSnapshot().cache["a.ts"]).toMatchObject({
    content: "alpha",
    startLine: 12,
    endLine: 14,
  });
});

test("closing pending tabs never resurrects them and reopening uses the cache", async () => {
  const read = deferred<{ content: string }>();
  let calls = 0;
  const viewer = new RepositoryViewer(undefined, () => {
    calls++;
    return read.promise;
  });
  viewer.open({ path: "closed.ts" });
  viewer.close("closed.ts");
  read.resolve({ content: "cached" });
  await viewer.load("closed.ts");
  expect(viewer.getSnapshot().paths).toEqual([]);
  expect(viewer.getSnapshot().active).toBeUndefined();
  viewer.open({ path: "closed.ts" });
  expect(viewer.getSnapshot().cache["closed.ts"].content).toBe("cached");
  expect(calls).toBe(1);
});

test("refresh preserves active tab, scroll, and preview; restored threads retain cache independently", async () => {
  let content = "initial";
  const first = new RepositoryViewer(undefined, async () => ({ content }));
  first.open({ path: "a.md" });
  first.open({ path: "b.ts" });
  await first.refresh();
  first.patch("a.md", { preview: true, scrollTop: 237, scrollLeft: 17 });
  content = "updated";
  await first.refresh();
  expect(first.getSnapshot().active).toBe("b.ts");
  expect(first.getSnapshot().cache["a.md"]).toMatchObject({
    content: "updated",
    preview: true,
    scrollTop: 237,
    scrollLeft: 17,
  });
  const restored = new RepositoryViewer(first.getSnapshot(), async () => {
    throw Error("should use cached content");
  });
  restored.open({ path: "a.md" });
  expect(restored.getSnapshot().cache["a.md"].content).toBe("updated");
  expect(
    new RepositoryViewer(undefined, async () => ({
      content: "other",
    })).getSnapshot().paths,
  ).toEqual([]);
  restored.close("a.md");
  expect(restored.getSnapshot().active).toBe("b.ts");
  expect(first.getSnapshot().paths).toEqual(["a.md", "b.ts"]);
});

test("failed refresh retains readable content but disables context until successful retry", async () => {
  let fail = false;
  const viewer = new RepositoryViewer(undefined, async () => {
    if (fail) throw Error("File deleted");
    return { content: "original" };
  });
  viewer.open({ path: "a.ts" });
  await viewer.refresh();
  fail = true;
  await viewer.refresh();
  expect(viewer.getSnapshot().cache["a.ts"]).toMatchObject({
    content: "original",
    error: "File deleted",
  });
  expect(fileContext(viewer.getSnapshot().cache["a.ts"])).toBeUndefined();
  fail = false;
  await viewer.load("a.ts");
  expect(fileContext(viewer.getSnapshot().cache["a.ts"])?.content).toBe(
    "original",
  );
});

test("line links force source and repeated navigation has distinct identity", async () => {
  const viewer = new RepositoryViewer(undefined, async () => ({
    content: "one\ntwo\nthree",
  }));
  viewer.open({ path: "README.md" });
  await viewer.refresh();
  viewer.patch("README.md", { preview: true });
  viewer.open({ path: "README.md", startLine: 2 });
  const first = viewer.getSnapshot().cache["README.md"];
  viewer.open({ path: "README.md", startLine: 3, endLine: 3 });
  expect(viewer.getSnapshot().cache["README.md"]).toMatchObject({
    preview: false,
    startLine: 3,
    endLine: 3,
  });
  expect(viewer.getSnapshot().cache["README.md"].navigationId).not.toBe(
    first.navigationId,
  );
  expect(viewer.getSnapshot().paths).toEqual(["README.md"]);
});

test("context selects exact inclusive lines, normalizes backwards selection and rejects invalid ranges", () => {
  const file = { path: "src/test.ts", content: "first\nsecond\nthird\nfourth" };
  expect(fileContext(file, { start: 3, end: 2 })).toEqual({
    kind: "selection",
    path: file.path,
    startLine: 2,
    endLine: 3,
    content: "second\nthird",
  });
  expect(fileContext(file, { start: 1, end: 1 })?.content).toBe("first");
  expect(fileContext(file, { start: 4, end: 4 })?.content).toBe("fourth");
  for (const range of [
    { start: 0, end: 2 },
    { start: 2, end: 5 },
    { start: 1.5, end: 2 },
    { start: NaN, end: 2 },
  ])
    expect(fileContext(file, range)).toBeUndefined();
});

test("context limit is inclusive; large files still support bounded selections and empty files", () => {
  const file = { path: "big.txt", content: "a".repeat(CONTEXT_LIMIT) };
  expect(fileContext(file)?.content.length).toBe(CONTEXT_LIMIT);
  file.content += "b\nshort";
  expect(fileContext(file)).toBeUndefined();
  expect(fileContext(file, { start: 1, end: 1 })).toBeUndefined();
  expect(fileContext(file, { start: 2, end: 2 })?.content).toBe("short");
  expect(fileContext({ path: "empty", content: "" })?.content).toBe("");
  expect(fileContext({ path: "loading" })).toBeUndefined();
});
