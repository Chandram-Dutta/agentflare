import { expect, test } from "bun:test";
import {
  isReviewed,
  patchFingerprint,
  reviewCommentContext,
  testResultState,
  type ReviewTestResult,
} from "./review";

const patch = `diff --git a/example.ts b/example.ts
--- a/example.ts
+++ b/example.ts
@@ -7,3 +7,4 @@
 before
-old value
+new value
+extra value
 after
@@ -40 +41 @@
-far old
+far new
`;

test("reviewed fingerprints survive unrelated revision changes, but not changed, loading or failed diffs", async () => {
  const hash = await patchFingerprint(patch);
  const progress = { reviewed: { "example.ts": hash } };
  expect(
    isReviewed(progress, "example.ts", await patchFingerprint(patch)),
  ).toBe(true);
  expect(
    isReviewed(
      progress,
      "example.ts",
      await patchFingerprint(patch.replace("new value", "changed")),
    ),
  ).toBe(false);
  expect(isReviewed(progress, "example.ts")).toBe(false);
  expect(isReviewed(progress, "different.ts", hash)).toBe(false);
  expect(isReviewed({ reviewed: {} }, "toString", hash)).toBe(false);
});

test("review context preserves old/new side and asymmetric selected line numbers, not current file text", () => {
  const input = {
    patch,
    path: "example.ts",
    revision: "abc",
    comment: "Fix this",
  };
  const old = reviewCommentContext({
    ...input,
    selection: { start: 8, end: 9, side: "deletions" },
  });
  expect(old.content).toEndWith("old value\nafter");
  expect(old.content).toContain(
    "Snapshot tree: abc\nDiff side: base (old)\nLines: 8-9",
  );
  const next = reviewCommentContext({
    ...input,
    selection: { start: 9, end: 8, side: "additions" },
  });
  expect(next.startLine).toBe(8);
  expect(next.endLine).toBe(9);
  expect(next.content).toEndWith("new value\nextra value");
  expect(() =>
    reviewCommentContext({ ...input, selection: { start: 8, end: 41 } }),
  ).toThrow("outside this patch");
  expect(() =>
    reviewCommentContext({
      ...input,
      selection: { start: 8, end: 9, side: "deletions", endSide: "additions" },
    }),
  ).toThrow("one side");
});

test("test success requires a real exit zero and identical before/after/current trees", () => {
  const result: ReviewTestResult = {
    command: "bun run test",
    revision: "before",
    afterRevision: "before",
    exitCode: 0,
    output: "0 failures",
    finishedAt: "2026-10-02T00:00:00Z",
  };
  expect(testResultState(result, "before")).toBe("passed");
  expect(testResultState({ ...result, exitCode: 1 }, "before")).toBe("failed");
  expect(testResultState({ ...result, exitCode: null }, "before")).toBe(
    "incomplete",
  );
  expect(testResultState(result, "later")).toBe("stale");
  expect(
    testResultState({ ...result, afterRevision: "during" }, "before"),
  ).toBe("stale");
  expect(
    testResultState({ ...result, afterRevision: "during" }, "during"),
  ).toBe("stale");
});
