import { afterAll, beforeAll, expect, test } from "bun:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import type {
  TestComputer,
  ComputerProbe,
} from "./__fixtures__/computer-worker";

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
        Probe: { className: "ComputerProbe", useSQLite: true },
      },
      bindings: {
        BETTER_AUTH_SECRET: "synthetic-test-key-at-least-32-characters",
        ARTIFACTS: true,
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
  mode: "probe-write" | "probe-read",
  name: string,
): ReturnType<ComputerProbe["exercise"]>;
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

test("Computer only destroys an idle runtime after pull and Artifacts succeed", async () => {
  const result = await call("idle");
  expect(result.events).toEqual([
    "quiesce",
    "pull",
    "artifact",
    "archive",
    "close",
    "destroy",
  ]);
  expect(result.saved?.persistence?.state).toBe("saved");
  expect(result.saved?.permissions).toEqual([]);
  expect(result.saved?.login).toBeUndefined();
  const busy = await call("busy");
  expect(busy.events).toEqual(["pull"]);
  expect(busy.saved?.persistence?.state).toBe("dirty");
  const active = await call("active");
  expect(active.events).toEqual(["pull", "artifact", "archive"]);
  expect(active.saved?.workspace).toBe("running");
});

test("container archive streams with declared lengths can be saved to R2", async () => {
  const result = await call("streamed-archive");
  expect(result.saved?.persistence?.state).toBe("saved");
  expect(result.archive).toBe("archive-bytes");
  expect(result.events).toContain("destroy");
  const truncated = await call("truncated-archive");
  expect(truncated.events).not.toContain("destroy");
  expect(truncated.checkpoint).toBeUndefined();
  expect(truncated.failure).toMatchObject({ stage: "upload-archive" });
  const refused = await call("quiesce-refused");
  expect(refused.saved?.workspace).toBe("running");
  expect(refused.events).toEqual(["quiesce"]);
});

test("explicit checkpoints keep the runtime live and refuse busy writers", async () => {
  const saved = await call("manual-save");
  expect(saved.events).toEqual(["pull", "artifact", "archive"]);
  expect(saved.saved).toMatchObject({
    workspace: "running",
    persistence: { state: "saved" },
  });
  const busy = await call("manual-busy");
  expect(busy.events).toEqual([]);
  expect(busy.checkpoint).toBeUndefined();
  expect(busy.observation).toContain("before saving or suspending");
});

test("startup timing measures actual initialization rather than an estimated delay", async () => {
  const result = await call("startup-timing");
  expect(result.startupMs).toBeGreaterThanOrEqual(20);
});

test("retry save retains the previous checkpoint and clears failure without restart or prompt replay", async () => {
  const result = await call("retry-save");
  const observation = result.observation as {
    previous: unknown;
    retained: unknown;
    failed: unknown;
  };
  expect(observation.previous).toEqual(observation.retained);
  expect(observation.failed).toMatchObject({
    workspace: "running",
    persistence: {
      state: "error",
      failure: {
        stage: "artifacts",
        reference: expect.any(String),
        at: expect.any(String),
      },
    },
  });
  expect(result.saved).toMatchObject({
    workspace: "running",
    persistence: { state: "saved" },
  });
  expect(result.saved?.persistence?.failure).toBeUndefined();
  expect(result.checkpoint).not.toEqual(observation.previous);
  expect(result.events).toEqual([
    "pull",
    "artifact",
    "archive",
    "pull",
    "artifact",
    "pull",
    "artifact",
    "archive",
  ]);
});

test("unchanged files reuse the checkpoint without archive or Artifacts work, but idle background changes do not", async () => {
  const unchanged = await call("unchanged-save");
  expect(unchanged.events).toEqual(["pull"]);
  expect(unchanged.observation).toEqual(unchanged.checkpoint);
  expect(unchanged.saved?.persistence?.unchanged).toBe(true);
  expect(unchanged.saved?.persistence?.durationMs).toBeGreaterThanOrEqual(0);
  const changed = await call("background-change");
  expect(changed.events).toEqual(["pull", "artifact", "archive"]);
  expect(changed.checkpoint).not.toEqual(changed.observation);
  expect(changed.saved?.persistence?.unchanged).toBe(false);
  const suspended = await call("unchanged-suspend");
  expect(suspended.events).toEqual(["quiesce", "pull", "close", "destroy"]);
  expect(suspended.saved?.workspace).toBe("suspended");
});

test("files changing during archiving never replace the last checkpoint", async () => {
  const result = await call("changes-during-save");
  expect(result.observation).toEqual(result.checkpoint);
  expect(result.saved).toMatchObject({
    workspace: "running",
    persistence: { state: "error", failure: { stage: "verify-files" } },
  });
  expect(result.saved?.persistence?.durationMs).toBeGreaterThanOrEqual(0);
  expect(result.events).not.toContain("destroy");
});

test("recovering a failed suspend pulls surviving files before startup and never restores an older archive", async () => {
  const recovered = await call("recover-live");
  expect(recovered.events).toEqual(["pull", "ensure", "action:connect"]);
  expect(recovered.saved?.workspace).toBe("running");
  expect(recovered.saved?.timings?.resumeMs).toBeGreaterThanOrEqual(10);
  const blocked = await call("recover-live-pull-fails");
  expect(blocked.events).toEqual(["pull"]);
  expect(blocked.saved?.workspace).toBe("failed");
  expect(blocked.saved?.timings?.resumeMs).toBeGreaterThanOrEqual(0);
});

test("failed sync/push never reports saved or destroys the only working copy", async () => {
  for (const mode of [
    "pull-fails",
    "skipped-file",
    "artifact-fails",
    "fingerprint-fails",
  ]) {
    const result = await call(mode);
    expect(result.events).not.toContain("destroy");
    expect(result.saved?.persistence?.state).toBe("error");
    expect(result.saved?.persistence?.savedAt).toBeUndefined();
  }
  const retained = await call("failure-keeps-checkpoint");
  expect(retained.observation).toEqual(retained.checkpoint);
  expect(retained.saved?.persistence?.state).toBe("error");
});

test("polls neither wake a stopped workspace nor renew its idle lease", async () => {
  const cold = await call("cold-read");
  expect(cold.events).toEqual([]);
  expect(cold.saved).toMatchObject({
    workspace: "failed",
    saved: false,
    interrupted: true,
  });
  expect((await call("poll-does-not-renew")).observation).toBe(123);
});

test("status remains readable while a checkpoint is blocked", async () => {
  const result = await call("slow-save");
  expect(result.observation).toMatchObject([
    { workspace: "running" },
    { persistence: { state: "saving" } },
    { thread: { workspace: "running" } },
  ]);
});

test("simultaneous resumes join one startup and suspended restores are fenced on failure", async () => {
  const concurrent = await call("resume-twice");
  expect(concurrent.events.filter((event) => event === "ensure")).toHaveLength(
    1,
  );
  expect(concurrent.saved?.workspace).toBe("running");
  const restored = await call("resume-suspended");
  expect(restored.events).toContain("restore");
  expect(restored.saved?.workspace).toBe("running");
  expect(restored.restorePending).toBeUndefined();
  const failed = await call("restore-fails");
  expect(failed.saved?.workspace).toBe("failed");
  expect(failed.restorePending).toBe(true);
});

test("deletion remains fenced even if Artifacts cleanup fails", async () => {
  const result = await call("delete-fails");
  expect(result.events).toEqual(["close", "destroy", "delete-artifact"]);
  expect(result.deleted).toBe(true);
  expect(result.saved).toBeNull();
});

test("credential epochs permit first login and fence stale writes after logout", async () => {
  expect(await call("write", "alice", { epoch: 0, value: null })).toEqual({
    epoch: 0,
  });
  expect(
    await call("write", "alice", { epoch: 0, value: "synthetic-login" }),
  ).toEqual({ epoch: 0 });
  expect(await call("read", "alice")).toEqual({
    epoch: 0,
    value: "synthetic-login",
  });
  expect(await call("read", "bob")).toEqual({ epoch: 0, value: null });
  expect(await call("write", "alice", { epoch: 0, value: null })).toEqual({
    epoch: 1,
  });
  expect(
    await call("write", "alice", { epoch: 0, value: "late-refresh" }),
  ).toBeNull();
  expect(
    await call("write", "alice", { epoch: 1, value: "new-login" }),
  ).toEqual({ epoch: 1 });
});

// Requires a locally built sandbox/Computer.Dockerfile image and Docker/FUSE.
test.skipIf(!process.env.COMPUTER_IMAGE)(
  "real computerd restores source and rollouts after container replacement, not credentials",
  async () => {
    const name = `agentflare-computer-test-${crypto.randomUUID()}`;
    async function docker(...args: string[]) {
      const proc = Bun.spawn(["docker", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(proc.stderr).text();
      if ((await proc.exited) !== 0) throw Error(output);
    }
    async function start() {
      await docker(
        "run",
        "-d",
        "--name",
        name,
        "--privileged",
        "-p",
        "127.0.0.1:19487:8080",
        process.env.COMPUTER_IMAGE!,
      );
      for (let i = 0; i < 60; i++) {
        if (
          (await fetch("http://127.0.0.1:19487/health").catch(() => null))?.ok
        )
          return;
        await Bun.sleep(250);
      }
      throw Error("computerd did not become ready");
    }
    try {
      await start();
      expect((await call("probe-write", name)).source).toBe(
        "uncommitted-source",
      );
      await docker("rm", "-f", name);
      await start();
      expect(await call("probe-read", name)).toEqual({
        stdout: "uncommitted-sourcerollout-state",
        source: "uncommitted-source",
      });
    } finally {
      await docker("rm", "-f", name).catch(() => {});
    }
  },
  60000,
);
