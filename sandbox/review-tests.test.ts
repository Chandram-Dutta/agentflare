import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { snapshotRepository } from "./repository.mjs";
import { runReviewTests } from "./review-tests.mjs";

let root: string, base: string;
const git = (...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { stdio: "pipe" })
    .toString()
    .trim();
const revision = () => snapshotRepository(root, base).revision;
const script = (value: string) =>
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ scripts: { test: value } }),
  );
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "review-tests-"));
  git("init");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.test");
  writeFileSync(join(root, "source.txt"), "before");
  git("add", ".");
  git("commit", "-m", "base");
  base = git("rev-parse", "HEAD");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("captures genuine success and failure, refuses stale inputs before running", async () => {
  script("printf 'actual output'; exit 7");
  const failure = await runReviewTests(root, base, revision());
  expect(failure.exitCode).toBe(7);
  expect(failure.output).toContain("actual output");
  expect(failure.afterRevision).toBe(failure.revision);
  script("printf 'passed'");
  expect((await runReviewTests(root, base, revision())).exitCode).toBe(0);
  await expect(runReviewTests(root, base, failure.revision)).rejects.toThrow(
    "checkout changed",
  );
});

test("missing script is unavailable, and source mutations invalidate even successful tests", async () => {
  expect((await runReviewTests(root, base, revision())).exitCode).toBeNull();
  script("printf 'changed' > source.txt");
  const result = await runReviewTests(root, base, revision());
  expect(result.exitCode).toBe(0);
  expect(result.afterRevision).not.toBe(result.revision);
});

test("the Node CLI reports missing Bun as unavailable, never exit zero", () => {
  script("echo should-not-run");
  const bin = mkdtempSync(join(tmpdir(), "review-path-"));
  try {
    symlinkSync(Bun.which("git")!, join(bin, "git"));
    const input = Buffer.from(
      JSON.stringify({ operation: "test", base, revision: revision() }),
    ).toString("base64");
    const result = JSON.parse(
      execFileSync(
        Bun.which("node")!,
        [join(import.meta.dir, "repository.mjs"), input, root],
        { env: { ...process.env, PATH: bin }, encoding: "utf8" },
      ),
    );
    expect(result.exitCode).toBeNull();
    expect(result.output).toContain("could not start Bun");
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("timeout kills background descendants before final snapshot; output capture is bounded", async () => {
  // The descendant would mutate the checkout after its parent was killed.
  script("sh -c '(sleep 0.4; echo leaked > leaked.txt) & wait'");
  const timed = await runReviewTests(root, base, revision(), { timeoutMs: 80 });
  expect(timed.exitCode).toBeNull();
  expect(timed.output).toContain("time limit");
  await Bun.sleep(550);
  expect(existsSync(join(root, "leaked.txt"))).toBe(false);
  expect(revision()).toBe(timed.afterRevision);
  script("yes verbose");
  const noisy = await runReviewTests(root, base, revision(), {
    maxBytes: 1024,
  });
  expect(noisy.exitCode).toBeNull();
  expect(noisy.output).toContain("capture limit");
  expect(Buffer.byteLength(noisy.output)).toBeLessThan(1200);
});

test("normal script exit also stops background descendants", async () => {
  script("sh -c '(sleep 0.3; echo leaked > leaked.txt) >/dev/null 2>&1 &'");
  const result = await runReviewTests(root, base, revision());
  await Bun.sleep(450);
  expect(existsSync(join(root, "leaked.txt"))).toBe(false);
  expect(revision()).toBe(result.afterRevision);
});
