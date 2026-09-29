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
