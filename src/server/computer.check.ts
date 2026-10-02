import { afterAll, beforeAll, expect, test } from "bun:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import type { TestComputer } from "./__fixtures__/computer-worker";

let mf: Miniflare;
beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [
      new URL("./__fixtures__/computer-worker.ts", import.meta.url).pathname,
    ],
    target: "browser",
    external: ["cloudflare:workers", "node:*"],
  });
  if (!build.success) throw new AggregateError(build.logs);
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: await build.outputs[0].text(),
      compatibilityDate: "2026-09-29",
      compatibilityFlags: ["nodejs_compat"],
      r2Buckets: { BACKUP_BUCKET: "test-backups" },
      durableObjects: {
        Test: { className: "TestComputer", useSQLite: true },
        Vault: { className: "ComputerCredentials", useSQLite: true },
      },
      bindings: {
        BETTER_AUTH_SECRET: "synthetic-test-key-at-least-32-characters",
      },
    }),
  );
  await mf.ready;
}, 20000);
afterAll(async () => {
  await mf?.dispose();
});

function call(
  mode: "read" | "write",
  name: string,
  extra?: object,
): Promise<unknown>;
function call(
  mode: string,
  name?: string,
  extra?: object,
): ReturnType<TestComputer["exercise"]>;
async function call(
  mode: string,
  name = crypto.randomUUID() as string,
  extra = {},
) {
  const response = await mf.dispatchFetch("http://test/", {
    method: "POST",
    body: JSON.stringify({ mode, name, ...extra }),
  });
  if (!response.ok) throw Error(await response.text());
  return response.json();
}

test("idle suspension commits both recovery sources before destroying", async () => {
  const result = await call("idle");
  expect(result.events).toEqual([
    "quiesce",
    "archive",
    "snapshot:checkpoint",
    "destroy",
  ]);
  expect(result.saved).toMatchObject({
    workspace: "suspended",
    persistence: { state: "saved" },
  });
  expect(result.checkpoint).toMatchObject({ snapshot: { id: "disk-1" } });
  expect(result.alarm).toBeNull();
});

test("busy work gets crash checkpoints and a lease without browser requests", async () => {
  const result = await call("busy");
  expect(result.events).toEqual(["snapshot:active", "lease"]);
  expect(result.recovery).toMatchObject({ id: "disk-1" });
  expect(result.checkpoint).toBeUndefined();
  expect(result.saved?.persistence?.state).toBe("dirty");
  expect(result.alarm).toBeGreaterThan(Date.now());
});

test("unknown activity is never interpreted as idle", async () => {
  const result = await call("unknown-activity");
  expect(result.events).toEqual(["lease"]);
  expect(result.alarm).toBeGreaterThan(Date.now());
});

test("unchanged checkpoints skip archive and snapshot; file changes do not", async () => {
  const unchanged = await call("unchanged");
  expect(unchanged.events).toEqual([]);
  expect(unchanged.checkpoint).toEqual(unchanged.before);
  const changed = await call("changed");
  expect(changed.events).toEqual(["archive", "snapshot:checkpoint"]);
  expect(changed.checkpoint).not.toEqual(changed.before);
});

test("changing files never advance a committed recovery pointer", async () => {
  const result = await call("changing");
  expect(result.checkpoint).toEqual(result.before);
  expect(result.saved).toMatchObject({
    workspace: "running",
    persistence: { state: "error", failure: { stage: "verify-files" } },
  });
});

test("archive errors and truncation leave live disk usable, never destroy it", async () => {
  for (const mode of ["archive", "truncated", "fingerprint", "refused"]) {
    const result = await call(mode);
    expect(result.events).not.toContain("destroy");
    expect(result.checkpoint).toBeUndefined();
    expect(result.saved?.workspace).toBe("running");
    expect(result.saved?.persistence?.state).toBe("error");
  }
});

test("a native snapshot outage still permits durable R2 save and suspension", async () => {
  const result = await call("snapshot");
  expect(result.saved?.workspace).toBe("suspended");
  expect(result.saved?.persistence?.state).toBe("saved");
  expect(result.checkpoint).not.toHaveProperty("snapshot");
});

test("automatic save failure reconnects on live disk and retries without a prompt", async () => {
  const result = await call("failed-suspend");
  expect(result.during).toMatchObject({
    workspace: "running",
    persistence: { state: "error" },
  });
  expect(result.events).toContain("action:connect");
  expect(result.events).not.toContain("action:prompt");
  expect(result.events).not.toContain("restore:r2");
  expect(result.saved?.persistence?.state).toBe("saved");
});

test("retry keeps the previous checkpoint until successful commit", async () => {
  const result = await call("retry");
  expect(result.during).toMatchObject({
    checkpoint: result.before,
    saved: { persistence: { state: "error" } },
  });
  expect(result.checkpoint).not.toEqual(result.before);
  expect(result.saved?.persistence?.state).toBe("saved");
});

test("native restore precedes agent connect; expired snapshots use R2", async () => {
  const restored = await call("resume");
  expect(restored.entrypoints).toEqual([
    ["/usr/bin/tini", "--", "/bin/bash", "/opt/agentflare/native-workspace.sh"],
  ]);
  expect(restored.events).toEqual([
    "restore:disk-1",
    "lease",
    "exec",
    "ensure",
    "action:connect",
  ]);
  expect(restored.saved?.workspace).toBe("running");
  const expired = await call("expired");
  expect(expired.events).toEqual([
    "boot",
    "lease",
    "exec",
    "restore:r2",
    "ensure",
    "action:connect",
  ]);
  const updated = await call("image-update");
  expect(updated.events).toEqual(expired.events);
});

test("failed native checkpoint startup restores matching R2 before agent connect", async () => {
  const result = await call("snapshot-boot-fails");
  expect(result.events).toEqual([
    "restore:disk-1",
    "destroy",
    "boot",
    "lease",
    "exec",
    "restore:r2",
    "ensure",
    "action:connect",
  ]);
  expect(result.saved?.workspace).toBe("running");
  expect(result.pending).toBeUndefined();
});

test("interrupted restores stay fenced, without starting an agent or replaying work", async () => {
  for (const mode of ["restore-fails", "boot-fails", "no-checkpoint"]) {
    const result = await call(mode);
    expect(result.saved?.workspace).toBe("failed");
    expect(result.events).not.toContain("ensure");
    expect(result.events).not.toContain("action:prompt");
    if (mode !== "no-checkpoint") expect(result.pending).toBe(true);
  }
});

test("long-turn recovery uses its crash snapshot, not an older idle archive", async () => {
  const result = await call("live-recovery");
  expect(result.events[0]).toBe("restore:disk-1");
  expect(result.saved?.interrupted).toBe(true);
  expect(result.events).not.toContain("action:prompt");
});

test("messages and file inspection transparently restore; concurrent connects join", async () => {
  const message = await call("message");
  expect(message.events.filter((e) => e.startsWith("action:"))).toEqual([
    "action:connect",
    "action:prompt",
  ]);
  const inspect = await call("inspect");
  expect(inspect.events.at(-1)).toBe("exec");
  expect(inspect.saved?.workspace).toBe("running");
  const concurrent = await call("concurrent");
  expect(concurrent.events.filter((e) => e === "ensure")).toHaveLength(1);
});

test("passive reads never wake a stopped workspace", async () => {
  expect((await call("passive")).events).toEqual([]);
});

test("reads stay responsive while backup is in flight", async () => {
  expect((await call("slow-save")).during).toMatchObject({
    persistence: { state: "saving" },
  });
});

test("a new prompt waits for suspension then restores and sends exactly once", async () => {
  const result = await call("queued-prompt");
  expect(result.during).toMatchObject({ workspace: "suspending" });
  expect(result.events).toEqual([
    "quiesce",
    "archive",
    "snapshot:checkpoint",
    "destroy",
    "restore:disk-1",
    "lease",
    "exec",
    "ensure",
    "action:connect",
    "action:prompt",
  ]);
  expect(result.saved?.workspace).toBe("running");
});

test("an interrupted suspension is recoverable without replaying a prompt", async () => {
  const result = await call("interrupted-suspend");
  expect(result.during).toMatchObject({ workspace: "failed" });
  expect(result.events).toEqual(["ensure", "action:connect"]);
  expect(result.saved?.workspace).toBe("running");
});

test("credential epochs fence stale writes after logout", async () => {
  expect(
    await call("write", "alice", { epoch: 0, value: "synthetic-login" }),
  ).toEqual({ epoch: 0 });
  expect(await call("read", "bob")).toEqual({ epoch: 0, value: null });
  expect(await call("write", "alice", { epoch: 0, value: null })).toEqual({
    epoch: 1,
  });
  expect(
    await call("write", "alice", { epoch: 0, value: "late-refresh" }),
  ).toBeNull();
});
