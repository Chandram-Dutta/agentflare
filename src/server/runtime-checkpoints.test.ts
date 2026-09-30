import { describe, expect, spyOn, test } from "bun:test";
import type { Sandbox } from "@cloudflare/sandbox";
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import type { Bindings } from "./env";
import { UserRuntime } from "./user-runtime";
import type { AcpSnapshot } from "@/lib/acp";

const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
const root = (id: string) => `/workspace/threads/${id}`;

class FakeStorage {
  records = new Map<string, unknown>();
  async get<T>(key: string) {
    return this.records.get(key) as T | undefined;
  }
  async put(key: string, value: unknown) {
    this.records.set(key, value);
  }
  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys])
      this.records.delete(key);
  }
  async list(options?: { prefix?: string }) {
    return new Map(
      [...this.records].filter(([key]) =>
        key.startsWith(options?.prefix ?? ""),
      ),
    );
  }
  async transaction<T>(fn: (tx: FakeStorage) => Promise<T>) {
    return fn(this);
  }
}

class FakeR2 {
  objects = new Map<string, string>();
  deletes: Array<string | string[]> = [];
  async put(key: string, value: string) {
    this.objects.set(key, value);
  }
  async get(key: string) {
    const value = this.objects.get(key);
    return value === undefined ? null : { json: async () => JSON.parse(value) };
  }
  async delete(key: string | string[]) {
    this.deletes.push(key);
    for (const item of Array.isArray(key) ? key : [key])
      this.objects.delete(item);
  }
}

class FakeSandbox {
  log: string[] = [];
  dirs = new Set<string>(["/workspace/threads"]);
  files = new Map<string, string>();
  backups = new Map<
    string,
    { dirs: Set<string>; files: Map<string, string> }
  >();
  backupOptions: unknown[] = [];
  backupCount = 0;
  failBackup = false;
  failAuthParking = false;
  failAuthRestore = false;
  running = false;
  healthy = true;
  quiesceStatus = 204;
  sessions: Record<string, { status: string }> = {};
  snapshots = new Map<string, AcpSnapshot>();
  promptGate?: Promise<void>;

  async exec(command: string) {
    this.log.push(`exec:${command}`);
    const parked = command.match(/\/tmp\/agentflare-auth-[a-f0-9-]+/)?.[0];
    if (parked) {
      if (this.failAuthParking && command.startsWith("mkdir"))
        return { success: false, stdout: "" };
      if (this.failAuthRestore && !command.startsWith("mkdir"))
        return { success: false, stdout: "" };
      const source = command.startsWith("mkdir")
        ? "/workspace/.codex/auth.json"
        : `${parked}/auth.json`;
      const destination = command.startsWith("mkdir")
        ? `${parked}/auth.json`
        : "/workspace/.codex/auth.json";
      if (this.files.has(source)) {
        this.files.set(destination, this.files.get(source)!);
        this.files.delete(source);
      }
      return { success: true, stdout: "" };
    }
    if (command === "test -d /workspace/threads")
      return { success: this.dirs.has("/workspace/threads"), stdout: "" };
    const repoTest = command.match(/^test -d '(.+\/repo\/\.git)'$/);
    if (repoTest) return { success: this.dirs.has(repoTest[1]), stdout: "" };
    if (command.includes(" clone -- ")) {
      const destination = command.match(/clone -- '[^']+' '([^']+)'/)?.[1];
      if (destination) {
        this.dirs.add(`${destination}/.git`);
        this.files.set(`${destination}/tracked.txt`, "tracked");
      }
      return { success: true, stdout: `origin/main\n${"a".repeat(40)}\n` };
    }
    const removed = command.match(/^rm -rf -- '([^']+)'$/);
    if (removed) {
      for (const dir of [...this.dirs])
        if (dir === removed[1] || dir.startsWith(`${removed[1]}/`))
          this.dirs.delete(dir);
      for (const file of [...this.files.keys()])
        if (file.startsWith(`${removed[1]}/`)) this.files.delete(file);
    }
    if (command.startsWith("mkdir -p /workspace/threads"))
      this.dirs.add("/workspace/threads");
    if (command === "test -f /workspace/.codex/auth.json")
      return {
        success: this.files.has("/workspace/.codex/auth.json"),
        stdout: "",
      };
    return { success: true, stdout: "" };
  }
  async getProcess() {
    return this.running ? { status: "running" } : undefined;
  }
  async startProcess() {
    this.log.push("startProcess");
    this.running = true;
  }
  async killProcess() {
    this.running = false;
  }
  async writeFile(path: string, value: string) {
    this.files.set(path, value);
  }
  async containerFetch(url: string, init: RequestInit = {}) {
    this.log.push(`fetch:${init.method ?? "GET"}:${url}`);
    if (url.endsWith("/health"))
      return new Response(null, { status: this.healthy ? 204 : 503 });
    if (url.endsWith("/activity")) return Response.json(this.sessions);
    if (url.endsWith("/quiesce"))
      return new Response(null, { status: this.quiesceStatus });
    const id = url.split("/").at(-1)!;
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    if (init.method === "POST" && this.promptGate) await this.promptGate;
    return Response.json(
      this.snapshots.get(id) ?? {
        status: "ready",
        messages: [],
        permissions: [],
      },
    );
  }
  async createBackup(options: unknown) {
    this.log.push("createBackup");
    this.backupOptions.push(options);
    if (this.failBackup) throw Error("synthetic backup failure");
    const id = `backup-${++this.backupCount}`;
    this.backups.set(id, {
      dirs: new Set(this.dirs),
      files: new Map(
        [...this.files].filter(([path]) => path.startsWith("/workspace/")),
      ),
    });
    return { id };
  }
  async restoreBackup(backup: { id: string }) {
    this.log.push(`restore:${backup.id}`);
    const image = this.backups.get(backup.id);
    if (!image) return { success: false };
    this.dirs = new Set(image.dirs);
    this.files = new Map(image.files);
    return { success: true };
  }
}

function fixture(
  owner = "owner-one",
  shared?: { storage: FakeStorage; bucket: FakeR2; sandbox: FakeSandbox },
) {
  const storage = shared?.storage ?? new FakeStorage();
  const bucket = shared?.bucket ?? new FakeR2();
  const sandbox = shared?.sandbox ?? new FakeSandbox();
  const env = {
    BACKUP_BUCKET: bucket,
    BACKUP_BUCKET_NAME: "test-backups",
    R2_ACCESS_KEY_ID: "synthetic-access",
    R2_SECRET_ACCESS_KEY: "synthetic-secret",
    CLOUDFLARE_R2_ACCOUNT_ID: "synthetic-account",
    BETTER_AUTH_URL: "https://installation.test",
    BETTER_AUTH_SECRET: "test-only-encryption-key-at-least-32-characters",
  } as unknown as Bindings;
  const runtime = new UserRuntime(
    sandbox as unknown as Sandbox<Bindings>,
    storage as unknown as DurableObjectStorage,
    env,
    owner,
  );
  return { runtime, storage, bucket, sandbox, env };
}

function seed(f: ReturnType<typeof fixture>, id: string) {
  f.storage.records.set(`workspace:${id}`, {
    started: true,
    agent: "codex",
    repository: "https://example.test/repo.git",
    baseSha: "a".repeat(40),
    baseBranch: "main",
  });
  f.sandbox.dirs.add(`${root(id)}/repo/.git`);
}

describe("durable runtime checkpoints", () => {
  test("a fresh runtime restores a missing disk before repository checks and native process start", async () => {
    const f = fixture();
    seed(f, a);
    f.sandbox.files.set(`${root(a)}/repo/untracked.txt`, "kept");
    await f.runtime.prepareSleep();
    f.sandbox.dirs.clear();
    f.sandbox.files.clear();
    f.sandbox.log.length = 0;
    await fixture("owner-one", f).runtime.acp(a);
    const restored = f.sandbox.log.indexOf("restore:backup-1");
    expect(restored).toBeGreaterThanOrEqual(0);
    expect(restored).toBeLessThan(
      f.sandbox.log.findIndex((x) => x.includes("/repo/.git")),
    );
    expect(restored).toBeLessThan(f.sandbox.log.indexOf("startProcess"));
    expect(f.sandbox.files.get(`${root(a)}/repo/untracked.txt`)).toBe("kept");
  });

  test("userSaved is sandbox-free, owner-keyed, and strips login and permissions", async () => {
    const f = fixture();
    seed(f, a);
    f.sandbox.snapshots.set(a, {
      status: "running",
      messages: [{ id: "message", role: "assistant", text: "saved" }],
      permissions: [{ id: "permission", title: "Do something", options: [] }],
      login: { id: "login", url: "https://device.invalid", message: "code" },
    });
    await f.runtime.acp(a);
    f.sandbox.log.length = 0;
    const saved = await fixture("owner-one", f).runtime.userSaved(a);
    expect(f.sandbox.log).toEqual([]);
    expect(saved).toMatchObject({
      status: "disconnected",
      interrupted: true,
      permissions: [],
    });
    expect(saved.login).toBeUndefined();
    expect(JSON.stringify(saved.messages)).toContain("saved");
    expect(
      (await fixture("owner-two", f).runtime.userSaved(a)).messages,
    ).toEqual([]);
    expect(f.bucket.objects.size).toBe(1);
  });

  test("initial checkout and deletion do not archive while a sibling is busy", async () => {
    const f = fixture();
    seed(f, b);
    f.sandbox.running = true;
    f.sandbox.sessions[b] = { status: "running" };
    await f.runtime.start(a, {
      repository: "https://example.test/repo.git",
      branch: "work",
      name: "Test",
      cloneToken: "synthetic",
    });
    expect(f.sandbox.backupCount).toBe(0);
    await f.runtime.delete(a);
    expect(f.sandbox.backupCount).toBe(0);
    expect((await f.runtime.status(b)).started).toBe(true);
  });

  test("a failed archive leaves the previously published pointer intact", async () => {
    const f = fixture();
    seed(f, a);
    await f.runtime.prepareSleep();
    const previous = f.storage.records.get("runtime-backup");
    await f.runtime.acp(a, {
      type: "prompt",
      text: "Review the code",
      requestId: "turn-1",
    });
    f.sandbox.failBackup = true;
    await expect(f.runtime.prepareSleep()).rejects.toThrow(
      "synthetic backup failure",
    );
    expect(f.storage.records.get("runtime-backup")).toEqual(previous);
    expect(f.storage.records.get("checkpoint-error")).toBe(true);
  });

  test("deletion tombstone fences callbacks; restore removes deleted thread and preserves sibling", async () => {
    const f = fixture();
    seed(f, a);
    seed(f, b);
    f.storage.records.set("auth-capability", "callback-token");
    await f.runtime.prepareSleep();
    await f.runtime.delete(a);
    expect(await f.runtime.checkpoint("callback-token")).toEqual({
      saved: false,
    });
    f.sandbox.dirs.clear();
    f.sandbox.files.clear();
    await fixture("owner-one", f).runtime.acp(b);
    expect(f.sandbox.dirs.has(`${root(a)}/repo/.git`)).toBe(false);
    expect(f.sandbox.dirs.has(`${root(b)}/repo/.git`)).toBe(true);
    await expect(fixture("owner-one", f).runtime.status(a)).rejects.toThrow(
      "deleted",
    );
  });

  test("stale callback capability is refused without touching the sandbox", async () => {
    const f = fixture();
    f.storage.records.set("auth-capability", "current");
    expect(await f.runtime.checkpoint("stale")).toBe(false);
    expect(f.sandbox.log).toEqual([]);
    expect(f.sandbox.backupCount).toBe(0);
  });

  test("prompt and callback checkpoint are serialized", async () => {
    const f = fixture();
    seed(f, a);
    await f.runtime.acp(a); // establish process and callback capability
    const token = f.storage.records.get("auth-capability") as string;
    let release!: () => void;
    f.sandbox.promptGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prompt = f.runtime.acp(a, {
      type: "prompt",
      text: "Review the code",
      requestId: "turn-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const checkpoint = f.runtime.checkpoint(token);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.sandbox.backupCount).toBe(0);
    release();
    await prompt;
    expect(await checkpoint).toEqual({ saved: false });
    expect(f.sandbox.backupCount).toBe(0);
  });

  test("active browsers save transcripts without quiescing; archive starts at the idle boundary", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(100_000);
    try {
      const f = fixture();
      seed(f, a);
      await f.runtime.acp(a);
      f.sandbox.sessions[a] = { status: "ready" };
      f.sandbox.snapshots.set(a, {
        status: "ready",
        permissions: [],
        messages: [{ id: "answer", role: "assistant", text: "Completed work" }],
      });
      const token = f.storage.records.get("auth-capability") as string;
      clock.mockReturnValue(129_999);
      // A re-created DO must retain the presence lease.
      const restarted = fixture("owner-one", f).runtime;
      expect(await restarted.checkpoint(token)).toEqual({ saved: false });
      expect((await restarted.userSaved(a)).messages[0].text).toBe(
        "Completed work",
      );
      expect(f.sandbox.log.some((x) => x.endsWith("/quiesce"))).toBe(false);
      expect(f.sandbox.backupCount).toBe(0);
      clock.mockReturnValue(130_000);
      expect(await restarted.checkpoint(token)).toEqual({ saved: true });
      expect(f.sandbox.backupCount).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });

  test("repository polling from a sibling renews presence; a busy agent still defers after expiry", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(100_000);
    try {
      const f = fixture();
      seed(f, a);
      seed(f, b);
      await f.runtime.acp(a);
      const token = f.storage.records.get("auth-capability") as string;
      // The repository fixture returns JSON for inspection, not a shell result.
      const exec = f.sandbox.exec.bind(f.sandbox);
      f.sandbox.exec = async (command) =>
        command.startsWith("node /opt/agentflare/repository.mjs")
          ? { success: true, stdout: '{"files":[]}' }
          : exec(command);
      clock.mockReturnValue(125_000);
      await f.runtime.inspect(b, "files");
      clock.mockReturnValue(130_000);
      expect(await f.runtime.checkpoint(token)).toEqual({ saved: false });
      clock.mockReturnValue(155_000);
      f.sandbox.sessions[a] = { status: "running" };
      expect(await f.runtime.checkpoint(token)).toEqual({ saved: false });
      expect(f.sandbox.backupCount).toBe(0);
      f.sandbox.sessions[a] = { status: "ready" };
      expect(await f.runtime.checkpoint(token)).toEqual({ saved: true });
      expect(f.sandbox.backupCount).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });

  test("backup includes ignored/staged/untracked workspace state, excludes auth, and disables gitignore", async () => {
    const f = fixture();
    seed(f, a);
    f.sandbox.files.set(`${root(a)}/repo/.git/index`, "synthetic-staged-index");
    f.sandbox.files.set(`${root(a)}/repo/ignored.log`, "ignored-but-preserved");
    f.sandbox.files.set(`${root(a)}/repo/untracked.txt`, "untracked");
    f.sandbox.files.set(
      "/workspace/.codex/auth.json",
      "must-not-be-archived-by-sdk",
    );
    f.sandbox.files.set(
      "/workspace/.codex/sessions/rollout.jsonl",
      "native-session",
    );
    f.sandbox.files.set("/workspace/.codex/state_5.sqlite", "native-index");
    await f.runtime.prepareSleep();
    expect(f.sandbox.backupOptions[0]).toEqual({
      dir: "/workspace",
      gitignore: false,
      ttl: 3_153_600_000,
    });
    const image = f.sandbox.backups.get("backup-1")!;
    expect(image.files.has("/workspace/.codex/auth.json")).toBe(false);
    expect(image.files.get("/workspace/.codex/sessions/rollout.jsonl")).toBe(
      "native-session",
    );
    expect(image.files.get("/workspace/.codex/state_5.sqlite")).toBe(
      "native-index",
    );
    expect(f.sandbox.files.get("/workspace/.codex/auth.json")).toBe(
      "must-not-be-archived-by-sdk",
    );
    expect(
      [...f.sandbox.files.keys()].some((path) =>
        path.startsWith("/tmp/agentflare-auth-"),
      ),
    ).toBe(false);
    expect(image.files.get(`${root(a)}/repo/.git/index`)).toBe(
      "synthetic-staged-index",
    );
    expect(image.files.get(`${root(a)}/repo/ignored.log`)).toBe(
      "ignored-but-preserved",
    );
    expect(image.files.get(`${root(a)}/repo/untracked.txt`)).toBe("untracked");
  });

  test("failed archives restore parked auth and credential isolation failures prevent backup", async () => {
    for (const failure of ["archive", "isolation"]) {
      const f = fixture();
      seed(f, a);
      f.sandbox.files.set("/workspace/.codex/auth.json", "preserve-login");
      f.sandbox.failBackup = failure === "archive";
      f.sandbox.failAuthParking = failure === "isolation";
      await expect(f.runtime.prepareSleep()).rejects.toThrow();
      expect(f.sandbox.files.get("/workspace/.codex/auth.json")).toBe(
        "preserve-login",
      );
      expect(f.storage.records.has("runtime-backup")).toBe(false);
      if (failure === "isolation")
        expect(f.sandbox.backupOptions).toHaveLength(0);
    }
  });

  test("failed credential restoration does not publish a new backup pointer", async () => {
    const f = fixture();
    seed(f, a);
    await f.runtime.prepareSleep();
    const previous = f.storage.records.get("runtime-backup");
    f.storage.records.set("workspace-revision", 10);
    f.sandbox.files.set("/workspace/.codex/auth.json", "preserve-login");
    f.sandbox.failAuthRestore = true;
    await expect(f.runtime.prepareSleep()).rejects.toThrow();
    expect(f.storage.records.get("runtime-backup")).toEqual(previous);
    expect([...f.sandbox.files.values()]).toContain("preserve-login");
  });

  test("legacy backup is replaced even without a new workspace revision", async () => {
    const f = fixture();
    seed(f, a);
    await f.runtime.prepareSleep();
    const pointer = f.storage.records.get("runtime-backup") as {
      format?: number;
    };
    delete pointer.format;
    await f.runtime.prepareSleep();
    expect(f.sandbox.backupCount).toBe(2);
    expect(f.storage.records.get("runtime-backup")).toMatchObject({
      format: 2,
    });
    await f.runtime.prepareSleep();
    expect(f.sandbox.backupCount).toBe(2);
  });

  test("a conversation-only turn dirties and produces a new archive", async () => {
    const f = fixture();
    seed(f, a);
    await f.runtime.prepareSleep();
    expect(f.sandbox.backupCount).toBe(1);
    await f.runtime.acp(a, {
      type: "prompt",
      text: "Review the code",
      requestId: "turn-1",
    });
    await f.runtime.prepareSleep();
    expect(f.sandbox.backupCount).toBe(2);
    expect(
      (f.storage.records.get("runtime-backup") as { backup: { id: string } })
        .backup.id,
    ).toBe("backup-2");
  });

  test("an unhealthy bridge must prove quiescence before retrying a checkpoint", async () => {
    const f = fixture();
    seed(f, a);
    f.sandbox.running = true;
    f.sandbox.quiesceStatus = 409;
    expect(await f.runtime.prepareSleep()).toBe(false);
    f.sandbox.healthy = false;
    expect(await f.runtime.prepareSleep()).toBe(false);
    expect(f.sandbox.backupCount).toBe(0);
    f.sandbox.quiesceStatus = 204;
    expect(await f.runtime.prepareSleep()).toBe(true);
    expect(f.sandbox.backupCount).toBe(1);
  });

  test("an unchanged idle runtime is not stopped and archived again", async () => {
    const f = fixture();
    seed(f, a);
    await f.runtime.prepareSleep();
    f.sandbox.running = true;
    f.sandbox.log.length = 0;
    expect(await f.runtime.prepareSleep()).toBe(true);
    expect(f.sandbox.log.some((x) => x.endsWith("/quiesce"))).toBe(false);
    expect(f.sandbox.backupCount).toBe(1);
  });

  test("shutdown holds the operation fence until the container has stopped", async () => {
    const f = fixture();
    seed(f, a);
    let release!: () => void;
    let entered!: () => void;
    const stopping = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const sleeping = f.runtime.prepareSleep(async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      f.sandbox.dirs.clear();
      f.sandbox.files.clear();
    });
    await stopping;
    const prompt = f.runtime.acp(a, {
      type: "prompt",
      text: "Continue",
      requestId: "after-sleep",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.sandbox.log).not.toContain("startProcess");
    release();
    expect(await sleeping).toBe(true);
    await prompt;
    expect(f.sandbox.log.indexOf("restore:backup-1")).toBeLessThan(
      f.sandbox.log.indexOf("startProcess"),
    );
  });
});
