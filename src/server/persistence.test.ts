import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";
import { api } from "./api";
import type { Bindings } from "./env";
import type { Project, Thread, WorkspaceData } from "@/lib/workspace";

const origin = "http://localhost:3000";
const secret = "local-test-only-secret-with-at-least-32-characters";
let mf: Miniflare;
let env: Bindings & { DB: D1Database };

function cookie(user = "alice", signingSecret = secret) {
  const token = `test-session-${user}`;
  return `better-auth.session_token=${encodeURIComponent(`${token}.${createHmac("sha256", signingSecret).update(token).digest("base64")}`)}`;
}

function request(
  path: string,
  method = "GET",
  body?: unknown,
  user = "alice",
  headers: Record<string, string> = {},
) {
  return api.request(
    `${origin}/api${path}`,
    {
      method,
      headers: {
        origin,
        cookie: cookie(user),
        "content-type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );
}

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default { fetch() { return new Response('test'); } }",
      d1Databases: ["DB"],
    }),
  );
  const DB = await mf.getD1Database("DB");
  env = {
    DB,
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: secret,
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-client-secret",
    ALLOWED_GITHUB_IDS: "101,202",
  };
  const migration = await readFile(
    new URL("../../migrations/0000_right_psynapse.sql", import.meta.url),
    "utf8",
  );
  await DB.batch(
    migration
      .split("--> statement-breakpoint")
      .filter((s) => s.trim())
      .map((s) => DB.prepare(s)),
  );
}, 20000);

beforeEach(async () => {
  await env.DB.batch(
    [
      "DELETE FROM user",
      "DELETE FROM verification",
      "DELETE FROM rate_limit",
    ].map((s) => env.DB.prepare(s)),
  );
  const now = Date.now();
  for (const [name, id] of [
    ["alice", "101"],
    ["bob", "202"],
  ]) {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO user (id,name,email,email_verified) VALUES (?,?,?,1)",
      ).bind(name, name, `${name}@example.test`),
      env.DB.prepare(
        "INSERT INTO account (id,account_id,provider_id,user_id,updated_at) VALUES (?,?,'github',?,?)",
      ).bind(`github-${name}`, id, name, now),
      env.DB.prepare(
        "INSERT INTO session (id,user_id,token,expires_at,updated_at) VALUES (?,?,?,?,?)",
      ).bind(
        `session-${name}`,
        name,
        `test-session-${name}`,
        now + 3600000,
        now,
      ),
    ]);
  }
});

afterAll(async () => {
  await mf?.dispose();
});

test("runtime endpoints enforce thread ownership and WebSocket origin before accessing a sandbox", async () => {
  const created = (await (
    await request("/projects", "POST", {
      name: "repo",
      repository: "https://github.com/acme/repo",
    })
  ).json()) as Project;
  const thread = (await (
    await request(`/projects/${created.id}/threads`, "POST", {
      name: "task",
      agent: "codex",
    })
  ).json()) as Thread;
  for (const operation of [
    "acp",
    "status",
    "terminal",
    "files",
    "git",
    "file?path=README.md",
    "diff?path=README.md",
    "review",
    "branch-diff?path=README.md",
    "publish",
    "start",
  ]) {
    const method = ["start", "publish"].includes(operation) ? "POST" : "GET";
    expect(
      (
        await request(
          `/threads/${thread.id}/runtime/${operation}`,
          method,
          undefined,
          "bob",
        )
      ).status,
    ).toBe(404);
  }
  expect(
    (
      await request(
        `/threads/${thread.id}/runtime/publish`,
        "POST",
        {},
        "alice",
        { origin: "https://evil.test" },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await request(
        `/threads/${thread.id}/runtime/terminal`,
        "GET",
        undefined,
        "alice",
        { origin: "https://evil.test" },
      )
    ).status,
  ).toBe(403);
  expect(
    (await request(`/threads/${thread.id}/runtime/file?path=..%2Fsecret`))
      .status,
  ).toBe(400);
  expect((await request(`/threads/${thread.id}/runtime/status`)).status).toBe(
    503,
  );
  expect(
    (
      await request(
        `/threads/${thread.id}/runtime/acp`,
        "POST",
        { type: "prompt", text: "x", requestId: "foreign" },
        "bob",
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await request(`/threads/${thread.id}/runtime/acp`, "POST", {
        type: "prompt",
        text: "",
        requestId: "bad",
        cwd: "/tmp",
      })
    ).status,
  ).toBe(400);
  for (const [length, status] of [
    [16000, 503],
    [16001, 400],
    [100001, 413],
  ]) {
    expect(
      (
        await request(`/threads/${thread.id}/runtime/acp`, "POST", {
          type: "prompt",
          text: "x".repeat(length),
          requestId: "boundary",
        })
      ).status,
    ).toBe(status);
  }
  expect(
    (
      await request(
        `/threads/${thread.id}/runtime/acp`,
        "POST",
        { type: "connect" },
        "alice",
        { origin: "https://evil.test" },
      )
    ).status,
  ).toBe(403);
});

async function createProject(user = "alice"): Promise<Project> {
  const response = await request(
    "/projects",
    "POST",
    {
      name: `${user}'s project`,
      repository: "https://github.com/acme/widget.git/",
    },
    user,
  );
  expect(response.status).toBe(201);
  return response.json();
}

test("thread deletion checks ownership/origin and waits for sandbox cleanup before removing metadata", async () => {
  const project = await createProject();
  const created = (await (
    await request(`/projects/${project.id}/threads`, "POST", {
      name: "disposable",
      agent: "codex",
    })
  ).json()) as Thread;
  let calls = 0;
  let fail = true;
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const cleanup = new Promise<void>((resolve) => {
    release = resolve;
  });
  env.Sandboxes = {
    idFromName(id: string) {
      expect(id).toBe(created.id);
      return id;
    },
    get() {
      return {
        async deleteWorkspace() {
          calls++;
          if (fail) throw new Error("cleanup failed");
          entered();
          await cleanup;
        },
      };
    },
  } as unknown as NonNullable<Bindings["Sandboxes"]>;
  try {
    expect(
      (await request(`/threads/${created.id}`, "DELETE", undefined, "bob"))
        .status,
    ).toBe(404);
    expect(
      (
        await request(`/threads/${created.id}`, "DELETE", undefined, "alice", {
          origin: "https://evil.test",
        })
      ).status,
    ).toBe(403);
    expect(calls).toBe(0);
    expect((await request(`/threads/${created.id}`, "DELETE")).status).toBe(
      502,
    );
    expect(
      ((await (await request("/workspace")).json()) as WorkspaceData).threads,
    ).toHaveLength(1);
    fail = false;
    const deleting = request(`/threads/${created.id}`, "DELETE");
    await enteredPromise;
    expect(
      ((await (await request("/workspace")).json()) as WorkspaceData).threads,
    ).toHaveLength(1);
    release();
    expect((await deleting).status).toBe(200);
    expect(
      ((await (await request("/workspace")).json()) as WorkspaceData).threads,
    ).toHaveLength(0);
    expect((await request(`/threads/${created.id}`, "DELETE")).status).toBe(
      404,
    );
    expect(calls).toBe(2);
  } finally {
    release();
    delete env.Sandboxes;
  }
});

async function createThread(
  projectId: string,
  user = "alice",
): Promise<Thread> {
  const response = await request(
    `/projects/${projectId}/threads`,
    "POST",
    { name: "fix permissions", agent: "codex" },
    user,
  );
  expect(response.status).toBe(201);
  return response.json();
}

describe("D1-backed workspace authorization", () => {
  test("persists normalized projects and thread edits across fresh requests; lists only the owner's data", async () => {
    const alice = await createProject();
    const bob = await createProject("bob");
    const thread = await createThread(alice.id);
    await createThread(bob.id, "bob");
    expect(
      (
        await request(`/threads/${thread.id}`, "PATCH", {
          name: "permissions fixed",
          agent: "claude",
          version: 1,
        })
      ).status,
    ).toBe(200);
    const response = await request("/workspace");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const state: WorkspaceData = await response.json();
    expect(state.projects).toEqual([
      { ...alice, repository: "https://github.com/acme/widget" },
    ]);
    expect(state.threads).toEqual([
      { ...thread, name: "permissions fixed", agent: "claude", version: 2 },
    ]);
  });

  test("foreign project/thread IDs cannot be used for writes, even when the session is valid", async () => {
    const project = await createProject();
    const thread = await createThread(project.id);
    expect(
      (
        await request(
          `/projects/${project.id}`,
          "PATCH",
          { name: "stolen", repository: project.repository, version: 1 },
          "bob",
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          `/projects/${project.id}/threads`,
          "POST",
          { name: "intruder", agent: "claude" },
          "bob",
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          `/threads/${thread.id}`,
          "PATCH",
          { name: "stolen", agent: "claude", version: 1 },
          "bob",
        )
      ).status,
    ).toBe(404);
    expect(await (await request("/workspace")).json()).toEqual({
      projects: [project],
      threads: [thread],
    });
  });

  test("concurrent stale writes cannot silently replace a saved project or thread", async () => {
    const project = await createProject();
    const thread = await createThread(project.id);
    const results = await Promise.all(
      ["first", "second"].map((name) =>
        request(`/projects/${project.id}`, "PATCH", {
          name,
          repository: project.repository,
          version: 1,
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = await results.find((r) => r.status === 200)!.json();
    expect(
      (
        await request(`/threads/${thread.id}`, "PATCH", {
          name: "winner",
          agent: "claude",
          version: 1,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(`/threads/${thread.id}`, "PATCH", {
          name: "stale",
          agent: "codex",
          version: 1,
        })
      ).status,
    ).toBe(409);
    const state: WorkspaceData = await (await request("/workspace")).json();
    expect(state.projects[0]).toEqual(winner);
    expect(state.threads[0].name).toBe("winner");
  });

  test("missing, forged, expired and revoked session cookies fail closed", async () => {
    for (const value of [
      "",
      cookie("alice", "wrong-signature"),
      cookie("unknown"),
    ]) {
      expect(
        (
          await request("/workspace", "GET", undefined, "alice", {
            cookie: value,
          })
        ).status,
      ).toBe(401);
    }
    await env.DB.prepare(
      "UPDATE session SET expires_at = ? WHERE user_id = 'alice'",
    )
      .bind(Date.now() - 1000)
      .run();
    expect((await request("/workspace")).status).toBe(401);
    await env.DB.prepare("DELETE FROM session WHERE user_id = 'bob'").run();
    expect((await request("/workspace", "GET", undefined, "bob")).status).toBe(
      401,
    );
  });

  test("removing an allowed GitHub ID immediately blocks an existing session", async () => {
    const response = await api.request(
      `${origin}/api/workspace`,
      { headers: { cookie: cookie() } },
      { ...env, ALLOWED_GITHUB_IDS: "202" },
    );
    expect(response.status).toBe(403);
  });

  test("cross-origin and missing-origin writes cannot change state", async () => {
    for (const origin of [
      "https://evil.test",
      "http://localhost:3000.evil.test",
      "null",
      "",
    ]) {
      const response = await request(
        "/projects",
        "POST",
        { name: "unwanted", repository: "https://github.com/acme/repo" },
        "alice",
        { origin },
      );
      expect(response.status).toBe(403);
    }
    expect(await (await request("/workspace")).json()).toEqual({
      projects: [],
      threads: [],
    });
  });

  test("the client cannot assign ownership or a thread's project; malformed and oversized bodies are rejected", async () => {
    const project = await createProject();
    expect(
      (
        await request("/projects", "POST", {
          name: "injected",
          repository: project.repository,
          ownerId: "bob",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(`/projects/${project.id}/threads`, "POST", {
          name: "injected",
          agent: "codex",
          projectId: "elsewhere",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/projects", "POST", {
          name: "x".repeat(5000),
          repository: project.repository,
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await api.request(
          `${origin}/api/projects`,
          { method: "POST", headers: { origin, cookie: cookie() }, body: "{" },
          env,
        )
      ).status,
    ).toBe(400);
  });

  test("unconfigured installations reveal no secrets and cannot create workspaces", async () => {
    expect(await (await api.request("/api/session", {}, {})).json()).toEqual({
      configured: false,
      user: null,
    });
    expect(
      (await api.request("/api/projects", { method: "POST" }, {})).status,
    ).toBe(503);
  });

  test("OAuth initiation creates state, requests no repo scope and rejects foreign callbacks; token APIs are not exposed", async () => {
    const response = await request("/auth/sign-in/social", "POST", {});
    expect(response.status).toBe(200);
    const result = await response.json();
    const url = new URL(result.url);
    expect(url.origin).toBe("https://github.com");
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${origin}/api/auth/callback/github`,
    );
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("scope")?.split(/[ ,]/)).not.toContain("repo");
    expect(
      (
        await request("/auth/sign-in/social", "POST", {
          callbackURL: "https://evil.test/",
        })
      ).status,
    ).toBe(400);
    expect(
      (await request("/auth/sign-in/social", "POST", { scopes: ["repo"] }))
        .status,
    ).toBe(400);
    expect(
      (
        await request("/auth/get-access-token", "POST", {
          accountId: "github-alice",
        })
      ).status,
    ).toBe(404);
  });

  test("sign-out invalidates the actual session, not just the browser cookie", async () => {
    expect((await request("/auth/sign-out", "POST", {})).status).toBe(200);
    expect((await request("/workspace")).status).toBe(401);
    expect((await request("/workspace", "GET", undefined, "bob")).status).toBe(
      200,
    );
  });
});
