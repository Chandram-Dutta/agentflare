import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { symmetricEncrypt } from "better-auth/crypto";
import { readFile } from "node:fs/promises";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";
import { api } from "./api";
import { getViewer } from "./auth";
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
  await DB.prepare(
    await readFile(
      new URL("../../migrations/0001_strong_scalphunter.sql", import.meta.url),
      "utf8",
    ),
  ).run();
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

test("runtime endpoints enforce thread ownership and write origin before accessing a sandbox", async () => {
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
    "saved",
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
  ).toBe(404);
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
    [100001, 400],
    [2100001, 413],
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
      await request(`/threads/${thread.id}/runtime/acp`, "POST", {
        type: "prompt",
        text: "",
        requestId: "attachment",
        attachments: [
          { type: "image", mimeType: "image/png", data: "a".repeat(120000) },
        ],
      })
    ).status,
  ).toBe(503);
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

test("GitHub onboarding uses the authenticated account and ignores claimed installation IDs", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  env.GITHUB_APP_ID = "123";
  env.GITHUB_APP_PRIVATE_KEY = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  for (const name of ["alice", "bob"]) {
    await env.DB.prepare(
      "UPDATE account SET access_token = ? WHERE user_id = ?",
    )
      .bind(
        await symmetricEncrypt({ key: secret, data: `${name}-token` }),
        name,
      )
      .run();
  }
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    (async (_url, init) => {
      const auth = new Headers(init?.headers).get("Authorization");
      if (String(_url).endsWith("/app"))
        return Response.json({ slug: "test-app" });
      return Response.json({
        total_count: auth === "Bearer alice-token" ? 1 : 0,
        installations:
          auth === "Bearer alice-token"
            ? [{ app_id: 123, suspended_at: null }]
            : [],
      });
    }) as typeof fetch,
  );
  try {
    const anon = await request(
      "/github/connection",
      "GET",
      undefined,
      "alice",
      { cookie: "" },
    );
    expect(anon.status).toBe(401);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    const alice = await request("/github/connection");
    expect(alice.status).toBe(200);
    expect(await alice.json()).toEqual({ connected: true, installUrl: null });
    const bob = await request(
      "/github/connection?installation_id=123&user=alice",
      "GET",
      undefined,
      "bob",
    );
    expect(bob.status).toBe(200);
    expect(await bob.json()).toEqual({
      connected: false,
      installUrl: "https://github.com/apps/test-app/installations/new",
    });
  } finally {
    fetchSpy.mockRestore();
    delete env.GITHUB_APP_ID;
    delete env.GITHUB_APP_PRIVATE_KEY;
  }
});

test("saved thread failures expose safe actionable errors with a log reference", async () => {
  const project = await createProject();
  const created = (await (
    await request(`/projects/${project.id}/threads`, "POST", {
      name: "cleanup",
      agent: "codex",
    })
  ).json()) as Thread;
  env.Sandboxes = {
    idFromName: (id: string) => id,
    get: () => ({
      userSaved: async () => {
        throw new Error("This thread's sandbox has been deleted.");
      },
    }),
  } as unknown as NonNullable<Bindings["Sandboxes"]>;
  try {
    const response = await request(`/threads/${created.id}/runtime/saved`);
    expect(response.status).toBe(500);
    const body = (await response.json()) as {
      code: string;
      error: string;
      reference: string;
    };
    expect(body.code).toBe("thread_cleanup_pending");
    expect(body.error).toContain("Retry deleting");
    expect(body.reference).toMatch(/^[a-f0-9-]{36}$/);
    expect(body.error).toContain(body.reference);
    expect(body.error).not.toContain("database and configuration");
  } finally {
    delete env.Sandboxes;
  }
});

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
      expect(id).toBe(
        "user-2bd806c97f0e00af1a1fc3328fa763a9269723c8db8fac4f93af71db18",
      );
      expect(id.length).toBe(63);
      return id;
    },
    get() {
      return {
        async userDelete(id: string) {
          expect(id).toBe(created.id);
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

test("hosted quotas are atomic per owner and per project; deletion frees a thread slot", async () => {
  env.HOSTED_MODE = "true";
  env.UNLIMITED_GITHUB_IDS = "101";
  const addProject = () =>
    request(
      "/projects",
      "POST",
      { name: "limited", repository: "https://github.com/acme/repo" },
      "bob",
    );
  try {
    // Exempt owner's existing data must not consume another account's quota.
    for (let i = 0; i < 3; i++) await createProject("alice");
    const owner = await createProject("alice");
    for (let i = 0; i < 3; i++) await createThread(owner.id, "alice");
    const responses = await Promise.all(Array.from({ length: 6 }, addProject));
    expect(responses.map((r) => r.status).sort()).toEqual([
      201, 201, 409, 409, 409, 409,
    ]);
    const projects = await Promise.all(
      responses
        .filter((r) => r.status === 201)
        .map((r) => r.json() as Promise<Project>),
    );
    const addThread = (id: string) =>
      request(
        `/projects/${id}/threads`,
        "POST",
        { name: "limited", agent: "codex" },
        "bob",
      );
    const first = await Promise.all(
      Array.from({ length: 5 }, () => addThread(projects[0].id)),
    );
    expect(first.map((r) => r.status).sort()).toEqual([
      201, 201, 409, 409, 409,
    ]);
    expect((await addThread(projects[1].id)).status).toBe(201);
    expect((await addThread(projects[1].id)).status).toBe(201);
    expect((await addThread(projects[1].id)).status).toBe(409);
    const created = (await first
      .find((r) => r.status === 201)!
      .json()) as Thread;
    let fail = true;
    env.Sandboxes = {
      idFromName: (id: string) => id,
      get: () => ({
        userDelete: async () => {
          if (fail) throw Error("synthetic failure");
        },
      }),
    } as unknown as NonNullable<Bindings["Sandboxes"]>;
    expect(
      (await request(`/threads/${created.id}`, "DELETE", undefined, "bob"))
        .status,
    ).toBe(502);
    expect((await addThread(projects[0].id)).status).toBe(409);
    fail = false;
    expect(
      (await request(`/threads/${created.id}`, "DELETE", undefined, "bob"))
        .status,
    ).toBe(200);
    expect((await addThread(projects[0].id)).status).toBe(201);
    expect((await addThread(projects[0].id)).status).toBe(409);
    // A verified GitHub identity grants exemption, not another user's headers.
    expect((await addThread(owner.id)).status).toBe(404);
    expect(
      (
        await request(
          "/projects",
          "POST",
          {
            name: "spoof",
            repository: "https://github.com/acme/repo",
            email: "alice@example.test",
          },
          "bob",
        )
      ).status,
    ).toBe(400);
  } finally {
    delete env.HOSTED_MODE;
    delete env.UNLIMITED_GITHUB_IDS;
    delete env.Sandboxes;
  }
});

test("self hosting is open and uncapped by default; optional admission remains enforced", async () => {
  const previous = env.ALLOWED_GITHUB_IDS;
  try {
    delete env.ALLOWED_GITHUB_IDS;
    expect((await request("/workspace", "GET", undefined, "bob")).status).toBe(
      200,
    );
    for (let i = 0; i < 3; i++) await createProject("bob");
    const project = await createProject("bob");
    for (let i = 0; i < 3; i++) await createThread(project.id, "bob");
    env.ALLOWED_GITHUB_IDS = "101";
    expect((await request("/workspace", "GET", undefined, "bob")).status).toBe(
      403,
    );
    env.ALLOWED_GITHUB_IDS = "typo-not-a-github-id";
    expect((await request("/workspace")).status).toBe(403);
    env.HOSTED_MODE = "true";
    expect((await request("/workspace", "GET", undefined, "bob")).status).toBe(
      200,
    );
    // Enabling limits preserves old data but prevents more creation.
    expect(
      (
        await request(
          "/projects",
          "POST",
          { name: "extra", repository: "https://github.com/acme/repo" },
          "bob",
        )
      ).status,
    ).toBe(409);
    await env.DB.prepare("DELETE FROM account WHERE user_id = 'bob'").run();
    expect((await request("/workspace", "GET", undefined, "bob")).status).toBe(
      403,
    );
  } finally {
    env.ALLOWED_GITHUB_IDS = previous;
    delete env.HOSTED_MODE;
  }
});

test("page session resolution verifies cookies, admission and revocation without exposing tokens", async () => {
  const alice = new Headers({ cookie: cookie() });
  expect(await getViewer(env, alice)).toEqual({
    configured: true,
    user: { id: "alice", name: "alice" },
  });
  expect(await getViewer(env, new Headers({ cookie: cookie("bob") }))).toEqual({
    configured: true,
    user: { id: "bob", name: "bob" },
  });
  expect(
    await getViewer(env, new Headers({ cookie: cookie("alice", "forged") })),
  ).toEqual({ configured: true, user: null });
  expect(await getViewer({ ...env, ALLOWED_GITHUB_IDS: "202" }, alice)).toEqual(
    { configured: true, user: null, denied: true },
  );
  await env.DB.prepare("DELETE FROM session WHERE user_id = 'alice'").run();
  expect(await getViewer(env, alice)).toEqual({ configured: true, user: null });
  expect(await getViewer({}, alice)).toEqual({ configured: false, user: null });
});

test("only shared Codex threads are exposed; retired records cannot access a runtime", async () => {
  const project = await createProject();
  const created = await createThread(project.id);
  expect(created.runtime).toBe("user");
  await env.DB.prepare(
    "INSERT INTO thread (id, project_id, name, agent, version, created_at) VALUES (?, ?, 'legacy', 'codex', 1, 1)",
  )
    .bind("old-thread", project.id)
    .run();
  const data = (await (await request("/workspace")).json()) as WorkspaceData;
  expect(data.threads).toEqual([created]);
  for (const operation of [
    "status",
    "saved",
    "acp",
    "files",
    "review",
    "start",
    "publish",
  ]) {
    expect(
      (
        await request(
          `/threads/old-thread/runtime/${operation}`,
          ["start", "publish"].includes(operation) ? "POST" : "GET",
        )
      ).status,
    ).toBe(404);
  }
  expect((await request("/threads/old-thread", "DELETE")).status).toBe(404);
  expect(
    (
      await request("/threads/old-thread", "PATCH", {
        name: "revive",
        agent: "codex",
        version: 1,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await request(`/projects/${project.id}/threads`, "POST", {
        name: "unsupported",
        agent: "claude",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request(`/threads/${created.id}`, "PATCH", {
        name: "unsupported",
        agent: "claude",
        version: 1,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request(`/projects/${project.id}/threads`, "POST", {
        name: "injected",
        agent: "codex",
        runtime: "thread",
      })
    ).status,
  ).toBe(400);
});

test("activity only exposes owned shared threads and never calls a startup method", async () => {
  const own = await createThread((await createProject()).id);
  const foreign = await createThread((await createProject("bob")).id, "bob");
  let calls = 0;
  env.Sandboxes = {
    idFromName: (name: string) => {
      expect(name).toMatch(/^user-[a-f0-9]{58}$/);
      return name;
    },
    get: () => ({
      userActivity: async () => {
        calls++;
        return {
          [own.id]: { status: "running", attention: false, turn: "own-turn" },
          [foreign.id]: {
            status: "ready",
            attention: false,
            turn: "private-turn",
          },
        };
      },
    }),
  } as unknown as NonNullable<Bindings["Sandboxes"]>;
  try {
    expect(
      (await request("/activity", "GET", undefined, "alice", { cookie: "" }))
        .status,
    ).toBe(401);
    expect(calls).toBe(0);
    const response = await request("/activity");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      [own.id]: { status: "running", attention: false, turn: "own-turn" },
    });
    expect(calls).toBe(1);
  } finally {
    delete env.Sandboxes;
  }
});

test("saved history requires ownership and never calls a startup method", async () => {
  const thread = await createThread((await createProject()).id);
  let calls = 0;
  env.Sandboxes = {
    idFromName: (name: string) => name,
    get: () => ({
      userSaved: async (id: string) => {
        expect(id).toBe(thread.id);
        calls++;
        return {
          status: "disconnected",
          saved: true,
          messages: [],
          permissions: [],
        };
      },
    }),
  } as unknown as NonNullable<Bindings["Sandboxes"]>;
  try {
    const path = `/threads/${thread.id}/runtime/saved`;
    expect(
      (await request(path, "GET", undefined, "alice", { cookie: "" })).status,
    ).toBe(401);
    expect((await request(path, "GET", undefined, "bob")).status).toBe(404);
    expect(calls).toBe(0);
    const response = await request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ saved: true });
    expect(calls).toBe(1);
  } finally {
    delete env.Sandboxes;
  }
});

test("workspace checkpoint callback rejects browser cookies and stale capabilities", async () => {
  const id = "a".repeat(64);
  const token = "b".repeat(72);
  let calls = 0;
  env.Sandboxes = {
    idFromString: (value: string) => {
      expect(value).toBe(id);
      return value;
    },
    get: () => ({
      saveRuntimeCheckpoint: async (value: string) => {
        calls++;
        return value === token ? { saved: true } : false;
      },
    }),
  } as unknown as NonNullable<Bindings["Sandboxes"]>;
  try {
    const path = `/runtime-checkpoint/${id}`;
    expect((await request(path, "POST", {})).status).toBe(401);
    expect(calls).toBe(0);
    expect(
      (
        await request(path, "POST", {}, "alice", {
          Authorization: `Bearer ${"c".repeat(72)}`,
        })
      ).status,
    ).toBe(401);
    const response = await request(path, "POST", {}, "alice", {
      cookie: "",
      Authorization: `Bearer ${token}`,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ saved: true });
    expect(calls).toBe(2);
  } finally {
    delete env.Sandboxes;
  }
});

test("checkpoint endpoint requires its capability rather than a browser login and returns no credentials", async () => {
  const id = "a".repeat(64);
  const token = "b".repeat(72);
  let calls = 0;
  env.Sandboxes = {
    idFromString: (value: string) => {
      expect(value).toBe(id);
      return value;
    },
    get: () => ({
      saveCodexCredentials: async (value: string, credentials: string) => {
        calls++;
        expect(credentials).toBe('{"tokens":{}}');
        return value === token;
      },
    }),
  } as unknown as NonNullable<Bindings["Sandboxes"]>;
  const send = (authorization?: string) =>
    api.request(
      `${origin}/api/codex-checkpoint/${id}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authorization ? { Authorization: authorization } : {}),
        },
        body: JSON.stringify({ credentials: '{"tokens":{}}' }),
      },
      env,
    );
  try {
    expect((await send()).status).toBe(401);
    expect(calls).toBe(0);
    expect((await send(`Bearer ${"c".repeat(72)}`)).status).toBe(401);
    const response = await send(`Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ saved: true });
  } finally {
    delete env.Sandboxes;
  }
});

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
          agent: "codex",
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
      {
        ...thread,
        name: "permissions fixed",
        agent: "codex",
        runtime: "user",
        version: 2,
      },
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
          { name: "intruder", agent: "codex" },
          "bob",
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          `/threads/${thread.id}`,
          "PATCH",
          { name: "stolen", agent: "codex", version: 1 },
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
          agent: "codex",
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
