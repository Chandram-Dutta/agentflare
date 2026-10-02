import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { snapshotRepository } from "./repository.mjs";

// Explicit user action only. Run repository code without any GitHub write token.
export async function runReviewTests(
  root,
  base,
  revision,
  { timeoutMs = 60000, maxBytes = 128 * 1024 } = {},
) {
  const before = snapshotRepository(root, base).revision;
  if (before !== revision)
    throw Error(
      "The checkout changed. Refresh the review before running tests.",
    );
  const command = "bun run test";
  const unavailable = (output) => ({
    revision: before,
    afterRevision: before,
    command,
    exitCode: null,
    output,
    finishedAt: new Date().toISOString(),
  });
  try {
    const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
    if (typeof pkg.scripts?.test !== "string" || !pkg.scripts.test.trim())
      return unavailable("Unavailable: package.json has no test script.");
  } catch {
    return unavailable(
      "Unavailable: no readable package.json with a test script.",
    );
  }
  const execution = await new Promise((resolve) => {
    // A dedicated process group lets bounds kill descendants, not just Bun.
    const child = spawn("bun", ["run", "test"], {
      cwd: root,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    let bytes = 0;
    let reason = "";
    const stop = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
    };
    const timer = setTimeout(() => {
      reason = "Incomplete: test process exceeded the time limit.";
      stop();
    }, timeoutMs);
    const collect = (chunk) => {
      const remaining = maxBytes - bytes;
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      bytes += chunk.length;
      if (bytes > maxBytes && !reason) {
        reason = "Incomplete: test output exceeded the capture limit.";
        stop();
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", () => {
      reason = "Unavailable: could not start Bun.";
    });
    // Kill any background descendants even if the test script exits normally.
    child.on("exit", stop);
    child.on("close", (code) => {
      clearTimeout(timer);
      stop();
      resolve({
        exitCode: reason ? null : code,
        output:
          Buffer.concat(chunks).toString("utf8") +
          (reason ? `\n${reason}` : ""),
      });
    });
  });
  return {
    revision: before,
    afterRevision: snapshotRepository(root, base).revision,
    command,
    ...execution,
    finishedAt: new Date().toISOString(),
  };
}
