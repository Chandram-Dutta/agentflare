import { expect, spyOn, test } from "bun:test";
import { runtimeFailure } from "./runtime-errors";

test("known runtime failures retain their cause and safe recovery guidance across operations", () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const deleted = runtimeFailure(
      new Error("This thread's sandbox has been deleted."),
      "load",
    );
    expect(deleted.code).toBe("thread_cleanup_pending");
    expect(deleted.error).toContain("Retry deleting");
    const restored = runtimeFailure(
      new Error("Saved workspace restoration failed."),
      "start",
    );
    expect(restored.code).toBe("workspace_restore_failed");
    expect(restored.error).toContain("do not delete");
    const cold = runtimeFailure(
      new Error("Codex bridge did not become ready."),
      "connect",
    );
    expect(cold.code).toBe("codex_startup_timeout");
    expect(cold.error).toContain("then reconnect");
    expect(log.mock.calls[2][0]).toEqual({
      event: "runtime_request_failed",
      operation: "connect",
      code: cold.code,
      reference: cold.reference,
    });
    expect(cold.error).toContain(cold.reference);
    expect(cold.reference).not.toBe(restored.reference);
  } finally {
    log.mockRestore();
  }
});

test("untrusted errors and near-matching provider messages cannot leak into responses or logs", () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const error of [
      new Error("Saved workspace restoration failed. token=private-secret"),
      { message: "private-secret", code: "private-secret" },
      "private-secret",
    ]) {
      const response = runtimeFailure(error, "delete");
      expect(response.code).toBe("delete_failed");
      expect(response.error).toContain("cleanup may be partial");
      expect(JSON.stringify(response)).not.toContain("private-secret");
    }
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-secret");
  } finally {
    log.mockRestore();
  }
});
