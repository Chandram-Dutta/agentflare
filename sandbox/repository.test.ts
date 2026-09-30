import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { inspectRepository } from "./repository.mjs";

let root: string;
const git = (...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
const inspect = (operation: string, path = "", staged = false) =>
  inspectRepository(root, { operation, path, staged });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentflare-repo-"));
  git("init");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.test");
  writeFileSync(join(root, "tracked.txt"), "original\n");
  writeFileSync(join(root, "other.txt"), "other\n");
  git("add", ".");
  git("commit", "-m", "initial");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("index and working tree diffs are distinct, and pathspec metacharacters stay literal", () => {
  writeFileSync(join(root, "tracked.txt"), "staged\n");
  git("add", "tracked.txt");
  writeFileSync(join(root, "tracked.txt"), "unstaged\n");
  expect(inspect("git").changes).toEqual([
    { path: "tracked.txt", index: "M", worktree: "M" },
  ]);
  const cached = inspect("diff", "tracked.txt", true).patch!;
  const working = inspect("diff", "tracked.txt").patch!;
  expect(cached).toContain("-original\n+staged");
  expect(cached).not.toContain("unstaged");
  expect(working).toContain("-staged\n+unstaged");
  expect(inspect("diff", ":(glob)**").patch).toBe("");
});

test("renames do not swallow subsequent status entries and deleted files still have a diff", () => {
  git("mv", "tracked.txt", "renamed file.txt");
  rmSync(join(root, "other.txt"));
  writeFileSync(join(root, "new file.txt"), "new\n");
  expect(inspect("git").changes).toEqual(
    expect.arrayContaining([
      { path: "renamed file.txt", index: "R", worktree: " " },
      { path: "other.txt", index: " ", worktree: "D" },
      { path: "new file.txt", index: "?", worktree: "?" },
    ]),
  );
  expect(inspect("diff", "other.txt").patch).toContain("-other");
});

test("inspection rejects traversal, credential metadata, binary files and symlink escapes", () => {
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "safe.txt"), "safe");
  writeFileSync(join(root, "binary"), Buffer.from([0, 1, 2]));
  symlinkSync("/etc/passwd", join(root, "outside"));
  symlinkSync(join(root, ".git", "config"), join(root, "credentials"));
  expect(inspect("file", "src/safe.txt").content).toBe("safe");
  for (const path of [
    "../secret",
    ".git/config",
    "outside",
    "credentials",
    "binary",
    "/etc/passwd",
  ])
    expect(() => inspect("file", path)).toThrow();
  expect(inspect("files").files).toEqual([
    "binary",
    "other.txt",
    "src/safe.txt",
    "tracked.txt",
  ]);
});

test("branch review includes committed, staged, unstaged and untracked files without changing the real index", () => {
  const base = git("rev-parse", "HEAD").toString().trim();
  writeFileSync(join(root, "tracked.txt"), "committed\n");
  git("commit", "-am", "agent commit");
  writeFileSync(join(root, "other.txt"), "staged\n");
  git("add", "other.txt");
  writeFileSync(join(root, "other.txt"), "working\n");
  writeFileSync(join(root, "new.txt"), "untracked\n");
  const index = git("write-tree").toString();
  const review = inspectRepository(root, {
    operation: "review",
    path: "",
    staged: false,
    base,
  });
  expect(review.changes).toEqual([
    { status: "A", path: "new.txt" },
    { status: "M", path: "other.txt" },
    { status: "M", path: "tracked.txt" },
  ]);
  expect(git("write-tree").toString()).toBe(index);
  const diff = inspectRepository(root, {
    operation: "branch-diff",
    path: "other.txt",
    staged: false,
    base,
  }).patch;
  expect(diff).toContain("-other\n+working");
  expect(diff).not.toContain("+staged");
  expect(
    inspectRepository(root, {
      operation: "branch-diff",
      path: ":(glob)**",
      staged: false,
      base,
    }).patch,
  ).toBe("");
});

test("publish snapshots preserve deletions, binary bytes and symlink targets, not the files they point at", () => {
  const base = git("rev-parse", "HEAD").toString().trim();
  rmSync(join(root, "tracked.txt"));
  const bytes = Buffer.from([0, 255, 10, 13]);
  writeFileSync(join(root, "binary.dat"), bytes);
  symlinkSync("/etc/passwd", join(root, "link"));
  const snapshot = inspectRepository(root, {
    operation: "snapshot",
    path: "",
    staged: false,
    base,
  });
  const entries = snapshot.entries as {
    path: string;
    mode: string;
    sha: string;
  }[];
  expect(entries.some((entry) => entry.path === "tracked.txt")).toBe(false);
  const binary = entries.find((entry) => entry.path === "binary.dat")!;
  const link = entries.find((entry) => entry.path === "link")!;
  expect(Buffer.from(snapshot.blobs![binary.sha], "base64")).toEqual(bytes);
  expect(link.mode).toBe("120000");
  expect(Buffer.from(snapshot.blobs![link.sha], "base64").toString()).toBe(
    "/etc/passwd",
  );
  const unchanged = entries.find((entry) => entry.path === "other.txt")!;
  expect(snapshot.blobs![unchanged.sha]).toBeUndefined();
});
