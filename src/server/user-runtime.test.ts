import { expect, test } from "bun:test";
import type { Sandbox } from "@cloudflare/sandbox";
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import type { Bindings } from "./env";
import { UserRuntime } from "./user-runtime";
import {
  openCredentials,
  sealCredentials,
  type SealedCredentials,
} from "./codex-credentials";

const secret = "test-only-encryption-key-at-least-32-characters";
const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";

function fixture() {
  const records = new Map<string, unknown>();
  const commands: string[] = [];
  const requests: { url: string; method?: string; body?: unknown }[] = [];
  const files = new Map<string, string>();
  let starts = 0;
  let running = false;
  const storage = {
    get: async (key: string) => records.get(key),
    put: async (key: string, value: unknown) => {
      records.set(key, value);
    },
    delete: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys])
        records.delete(key);
    },
    transaction: async (callback: (tx: unknown) => unknown) =>
      callback(storage),
  };
  const sandbox = {
    async exec(command: string) {
      commands.push(command);
      if (command === "rm -f /workspace/.codex/auth.json")
        files.delete("/workspace/.codex/auth.json");
      return {
        success:
          command !== "test -f /workspace/.codex/auth.json" ||
          files.has("/workspace/.codex/auth.json"),
        stdout: "",
      };
    },
    async writeFile(path: string, value: string) {
      files.set(path, value);
    },
    async getProcess() {
      return running ? { status: "running" } : undefined;
    },
    async startProcess() {
      starts++;
      running = true;
    },
    async killProcess() {
      running = false;
    },
    async containerFetch(url: string, init: RequestInit) {
      requests.push({
        url,
        method: init.method,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.endsWith("/health") || init.method === "DELETE")
        return new Response(null, { status: 204 });
      return Response.json({ status: "ready", messages: [], permissions: [] });
    },
  };
  const runtime = new UserRuntime(
    sandbox as unknown as Sandbox<Bindings>,
    storage as unknown as DurableObjectStorage,
    {
      BETTER_AUTH_SECRET: secret,
      BETTER_AUTH_URL: "https://installation.test",
    },
    "owner-one",
  );
  for (const id of [a, b])
    records.set(`workspace:${id}`, { started: true, agent: "codex" });
  return { runtime, records, commands, files, requests, starts: () => starts };
}

test("credentials are randomized, authenticated and bound to one user's runtime", async () => {
  const value = '{"tokens":{"refresh_token":"synthetic"}}';
  const first = await sealCredentials(secret, "one", value);
  expect(await openCredentials(secret, "one", first)).toBe(value);
  expect((await sealCredentials(secret, "one", value)).ciphertext).not.toBe(
    first.ciphertext,
  );
  expect(JSON.stringify(first)).not.toContain("synthetic");
  await expect(openCredentials(secret, "two", first)).rejects.toThrow();
  await expect(
    openCredentials(secret + "changed", "one", first),
  ).rejects.toThrow();
});

test("concurrent threads share one process, restore auth once and deleting one preserves account and sibling", async () => {
  const f = fixture();
  const sealed = await sealCredentials(
    secret,
    "owner-one",
    '{"tokens":{"refresh_token":"saved"}}',
  );
  f.records.set("codex-credentials", sealed);
  await Promise.all([f.runtime.acp(a), f.runtime.acp(b)]);
  expect(f.starts()).toBe(1);
  expect(f.files.get("/workspace/.codex/auth.json")).toContain("saved");
  await f.runtime.delete(a);
  expect(f.records.get("codex-credentials")).toEqual(sealed);
  expect(f.commands.filter((c) => c.startsWith("rm -rf"))).toEqual([
    `rm -rf -- '/workspace/threads/${a}'`,
  ]);
  expect((await f.runtime.acp(b)).status).toBe("ready");
  await expect(f.runtime.acp(a)).rejects.toThrow("deleted");
  await expect(f.runtime.delete("../../.codex")).rejects.toThrow(
    "Invalid thread id",
  );
});

test("connect reaches a live bridge as an action; passive polling stays read-only", async () => {
  const f = fixture();
  await f.runtime.acp(a);
  await f.runtime.acp(a, { type: "connect" });
  expect(f.starts()).toBe(1);
  expect(f.requests.filter((r) => r.url.endsWith(`/acp/${a}`))).toEqual([
    { url: `http://127.0.0.1/acp/${a}`, method: "GET", body: undefined },
    {
      url: `http://127.0.0.1/acp/${a}`,
      method: "POST",
      body: { type: "connect" },
    },
  ]);
});

test("only current callback capability can replace or clear saved credentials", async () => {
  const f = fixture();
  f.records.set("auth-capability", "current");
  expect(await f.runtime.persist("stale", '{"tokens":{}}')).toBe(false);
  expect(f.records.has("codex-credentials")).toBe(false);
  expect(
    await f.runtime.persist("current", '{"tokens":{"refresh_token":"new"}}'),
  ).toBe(true);
  expect(
    await openCredentials(
      secret,
      "owner-one",
      f.records.get("codex-credentials") as SealedCredentials,
    ),
  ).toContain("new");
  await expect(f.runtime.persist("current", "partial{")).rejects.toThrow();
  expect(await f.runtime.persist("stale", null)).toBe(false);
  expect(f.records.has("codex-credentials")).toBe(true);
  expect(await f.runtime.persist("current", null)).toBe(true);
  expect(f.records.has("codex-credentials")).toBe(false);
});

test("restart never overwrites a newer local token rotation with an older checkpoint", async () => {
  const f = fixture();
  f.records.set(
    "codex-credentials",
    await sealCredentials(secret, "owner-one", '{"token":"old"}'),
  );
  f.files.set("/workspace/.codex/auth.json", '{"token":"new"}');
  await f.runtime.acp(a);
  expect(f.files.get("/workspace/.codex/auth.json")).toBe('{"token":"new"}');
});

test("global logout clears both stores and fences delayed checkpoint writes", async () => {
  const f = fixture();
  await f.runtime.acp(a);
  const capability = f.records.get("auth-capability") as string;
  await f.runtime.persist(capability, '{"token":"before-logout"}');
  f.files.set("/workspace/.codex/auth.json", '{"token":"before-logout"}');
  await f.runtime.acp(a, { type: "logout" });
  expect(await f.runtime.persist(capability, '{"token":"late-write"}')).toBe(
    false,
  );
  expect(f.records.has("codex-credentials")).toBe(false);
  expect(f.files.has("/workspace/.codex/auth.json")).toBe(false);
  expect((await f.runtime.status(b)).started).toBe(true);
  await f.runtime.acp(b);
  expect(f.files.has("/workspace/.codex/auth.json")).toBe(false);
});
