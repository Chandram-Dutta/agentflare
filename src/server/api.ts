import { Hono } from "hono";
import { createHash } from "node:crypto";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { and, asc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  projectInput,
  projectUpdate,
  threadInput,
  threadUpdate,
} from "@/lib/workspace";
import { createAuth, getViewer, getGitHubConnection } from "./auth";
import { installationReady, type Bindings } from "./env";
import { account } from "./db/auth-schema";
import { project, thread } from "./db/workspace-schema";
import { repositoryCloneToken, repositoryWriteToken, github } from "./github";
import { repositoryPath } from "@/lib/runtime";
import { promptActionSchema } from "@/lib/acp-content";
import type { AcpAction } from "@/lib/acp";
import type { ThreadSandbox } from "./sandbox";
import { runtimeFailure } from "./runtime-errors";

function userSandboxName(userId: string) {
  // Sandbox SDK names are limited to 63 characters, regardless of user ID length.
  return `user-${createHash("sha256").update(userId).digest("hex").slice(0, 58)}`;
}

async function runtime(
  env: Bindings,
  owner: string,
  row: { id: string; runtime: string },
  initialize = false,
) {
  if (row.runtime === "computer") {
    if (!env.Computers || !env.ComputerAuth)
      throw new HTTPException(503, {
        message: "The Computer runtime is not configured.",
      });
    return env.Computers.get(
      env.Computers.idFromName(JSON.stringify([owner, row.id])),
    );
  }
  if (!env.Sandboxes)
    throw new HTTPException(503, {
      message: "The sandbox runtime is not configured.",
    });
  if (initialize) {
    const { getSandbox } = await import("@cloudflare/sandbox");
    return getSandbox<ThreadSandbox>(env.Sandboxes, userSandboxName(owner));
  }
  return env.Sandboxes.get(env.Sandboxes.idFromName(userSandboxName(owner)));
}

export const api = new Hono<{
  Bindings: Bindings;
  Variables: {
    user: { id: string; name: string };
    db: ReturnType<typeof drizzle>;
  };
}>().basePath("/api");

api.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});

api.onError((error, c) => {
  if (error instanceof HTTPException)
    return c.json({ error: error.message }, error.status);
  return c.json(
    runtimeFailure(
      error,
      c.req.path.includes("/runtime/") ? "load" : "request",
    ),
    500,
  );
});

api.get("/health", (c) =>
  c.json({
    status: "ok",
    execution: c.env?.Sandboxes ? "sandbox-configured" : "not-configured",
  }),
);

// Deliberately expose only sign-in/callback/sign-out, not token retrieval or
// account-management endpoints. Login tokens are not repository credentials.
api.on(["GET", "POST"], "/auth/*", bodyLimit({ maxSize: 8192 }), async (c) => {
  if (!installationReady(c.env))
    return c.json({ error: "Installation setup is required." }, 503);
  const path = c.req.path;
  // Failed OAuth must never establish or replace an identity. An existing
  // session can resume installation verification; everyone else signs in again.
  if (c.req.method === "GET" && path === "/api/auth/error") {
    const session = await getViewer(c.env, c.req.raw.headers);
    return c.redirect(session.user ? "/connect/github" : "/?auth=failed", 303);
  }
  const allowed =
    (c.req.method === "POST" &&
      ["/api/auth/sign-in/social", "/api/auth/sign-out"].includes(path)) ||
    (c.req.method === "GET" && path === "/api/auth/callback/github");
  if (!allowed) return c.notFound();
  if (
    c.req.method === "POST" &&
    c.req.header("Origin") !== c.env.BETTER_AUTH_URL
  ) {
    return c.json({ error: "Origin is not allowed." }, 403);
  }
  if (path === "/api/auth/sign-in/social") {
    if (
      !z.strictObject({}).safeParse(await c.req.json().catch(() => null))
        .success
    ) {
      return c.json(
        { error: "Sign-in takes no client-supplied options." },
        400,
      );
    }
    // The server owns provider, scopes and redirect destinations. Build from a
    // URL string, not vinext's tracked Request proxy (which workerd cannot clone).
    const headers = new Headers(c.req.raw.headers);
    headers.delete("content-length");
    headers.set("Content-Type", "application/json");
    return createAuth(c.env).handler(
      new Request(c.req.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          provider: "github",
          callbackURL: `${c.env.BETTER_AUTH_URL}/connect/github`,
          errorCallbackURL: `${c.env.BETTER_AUTH_URL}/?auth=failed`,
          disableRedirect: true,
        }),
      }),
    );
  }
  return createAuth(c.env).handler(c.req.raw);
});

api.get("/session", async (c) => {
  const session = await getViewer(c.env, c.req.raw.headers);
  if (session.denied)
    return c.json(
      { error: "This account is no longer allowed on this installation." },
      403,
    );
  return c.json({
    configured: session.configured,
    user: session.user,
  });
});

// Container-to-Worker credential checkpoint. This route deliberately precedes
// browser authentication: a per-runtime capability, never a browser session,
// authorizes it. Credential contents are never returned or logged.
api.on(
  "POST",
  ["/codex-checkpoint/:id", "/computer-auth/:id"],
  bodyLimit({ maxSize: 65536 }),
  async (c) => {
    const namespace = c.req.path.startsWith("/api/computer-auth/")
      ? c.env.Computers
      : c.env.Sandboxes;
    if (!namespace || !/^[a-f0-9]{64}$/.test(c.req.param("id")))
      return c.notFound();
    const token = c.req
      .header("Authorization")
      ?.match(/^Bearer ([a-f0-9-]{72})$/)?.[1];
    if (!token || token.length !== 72)
      return c.json({ error: "Unauthorized" }, 401);
    const parsed = z
      .strictObject({ credentials: z.string().max(32768).nullable() })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid checkpoint" }, 400);
    try {
      const sandbox = namespace.get(namespace.idFromString(c.req.param("id")));
      if (!(await sandbox.saveCodexCredentials(token, parsed.data.credentials)))
        return c.json({ error: "Unauthorized" }, 401);
      return c.json({ saved: true });
    } catch {
      return c.json({ error: "Checkpoint unavailable" }, 503);
    }
  },
);

// Empty wake-up notification from the bridge. Read state directly from the
// owning runtime, never trust a browser-supplied transcript or archive handle.
api.post("/runtime-checkpoint/:id", bodyLimit({ maxSize: 1024 }), async (c) => {
  if (!c.env.Sandboxes || !/^[a-f0-9]{64}$/.test(c.req.param("id")))
    return c.notFound();
  const token = c.req
    .header("Authorization")
    ?.match(/^Bearer ([a-f0-9-]{72})$/)?.[1];
  if (!token) return c.json({ error: "Unauthorized" }, 401);
  try {
    const sandbox = c.env.Sandboxes.get(
      c.env.Sandboxes.idFromString(c.req.param("id")),
    );
    const result = await sandbox.saveRuntimeCheckpoint(token);
    if (!result) return c.json({ error: "Unauthorized" }, 401);
    return c.json(result);
  } catch {
    return c.json({ error: "Checkpoint unavailable" }, 503);
  }
});

// All routes below require both a valid session and current operator admission.
api.use(
  "*",
  (c, next) =>
    bodyLimit({
      maxSize: /^\/api\/threads\/[^/]+\/runtime\/acp$/.test(c.req.path)
        ? 2_100_000
        : 4096,
    })(c, next),
  async (c, next) => {
    if (!installationReady(c.env))
      return c.json({ error: "Installation setup is required." }, 503);
    if (
      !["GET", "HEAD"].includes(c.req.method) &&
      c.req.header("Origin") !== c.env.BETTER_AUTH_URL
    ) {
      return c.json({ error: "Origin is not allowed." }, 403);
    }
    const session = await getViewer(c.env, c.req.raw.headers);
    if (session.denied)
      return c.json(
        { error: "This account is not allowed on this installation." },
        403,
      );
    if (!session.user) return c.json({ error: "Sign in to continue." }, 401);
    c.set("user", session.user);
    c.set("db", drizzle(c.env.DB!));
    await next();
  },
);

api.get("/github/connection", async (c) => {
  try {
    return c.json(
      await getGitHubConnection(c.env, c.req.raw.headers, c.get("user").id),
    );
  } catch {
    return c.json(
      {
        error:
          "Could not verify GitHub App access. Retry, or sign in again if your GitHub authorization has expired.",
      },
      502,
    );
  }
});

const projectFields = {
  id: project.id,
  name: project.name,
  repository: project.repository,
  version: project.version,
  createdAt: project.createdAt,
};

// Retired runtime records must never be opened in a different sandbox.
const supportedThread = and(
  inArray(thread.runtime, ["user", "computer"]),
  eq(thread.agent, "codex"),
);

api.get("/workspace", async (c) => {
  const db = c.get("db");
  const owner = eq(project.ownerId, c.get("user").id);
  const [projects, threads] = await db.batch([
    db
      .select(projectFields)
      .from(project)
      .where(owner)
      .orderBy(asc(project.createdAt), asc(project.id)),
    db
      .select(getTableColumns(thread))
      .from(thread)
      .innerJoin(project, eq(thread.projectId, project.id))
      .where(and(owner, supportedThread))
      .orderBy(asc(thread.createdAt), asc(thread.id)),
  ]);
  return c.json({ projects, threads });
});

api.post("/projects", async (c) => {
  const input = projectInput.safeParse(await c.req.json().catch(() => null));
  if (!input.success)
    return c.json(
      { error: "Enter a name and a GitHub repository root URL." },
      400,
    );
  const result = await c
    .get("db")
    .insert(project)
    .values({
      ...input.data,
      id: crypto.randomUUID(),
      ownerId: c.get("user").id,
      createdAt: Date.now(),
    })
    .returning(projectFields)
    .get();
  return c.json(result, 201);
});

api.patch("/projects/:id", async (c) => {
  const input = projectUpdate.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: "Invalid project update." }, 400);
  const owned = and(
    eq(project.id, c.req.param("id")),
    eq(project.ownerId, c.get("user").id),
  );
  const db = c.get("db");
  if (!(await db.select({ id: project.id }).from(project).where(owned).get()))
    return c.notFound();
  const result = await db
    .update(project)
    .set({
      name: input.data.name,
      repository: input.data.repository,
      version: sql`${project.version} + 1`,
    })
    .where(and(owned, eq(project.version, input.data.version)))
    .returning(projectFields)
    .get();
  if (!result)
    return c.json(
      {
        error: "This project changed in another window. Reload before saving.",
      },
      409,
    );
  return c.json(result);
});

api.post("/projects/:id/threads", async (c) => {
  const input = threadInput.safeParse(await c.req.json().catch(() => null));
  if (!input.success)
    return c.json(
      { error: "Enter a thread name and choose a supported agent." },
      400,
    );
  const db = c.get("db");
  const owned = await db
    .select({ id: project.id })
    .from(project)
    .where(
      and(
        eq(project.id, c.req.param("id")),
        eq(project.ownerId, c.get("user").id),
      ),
    )
    .get();
  if (!owned) return c.notFound();
  const result = await db
    .insert(thread)
    .values({
      ...input.data,
      id: crypto.randomUUID(),
      projectId: owned.id,
      runtime:
        c.env.Computers && c.env.ComputerAuth && c.env.ARTIFACTS
          ? "computer"
          : "user",
      createdAt: Date.now(),
    })
    .returning()
    .get();
  return c.json(result, 201);
});

api.patch("/threads/:id", async (c) => {
  const input = threadUpdate.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: "Invalid thread update." }, 400);
  const db = c.get("db");
  const owned = await db
    .select({ id: thread.id })
    .from(thread)
    .innerJoin(project, eq(thread.projectId, project.id))
    .where(
      and(
        supportedThread,
        eq(thread.id, c.req.param("id")),
        eq(project.ownerId, c.get("user").id),
      ),
    )
    .get();
  if (!owned) return c.notFound();
  const result = await db
    .update(thread)
    .set({
      name: input.data.name,
      version: sql`${thread.version} + 1`,
    })
    .where(and(eq(thread.id, owned.id), eq(thread.version, input.data.version)))
    .returning()
    .get();
  if (!result)
    return c.json(
      { error: "This thread changed in another window. Reload before saving." },
      409,
    );
  return c.json(result);
});

api.delete("/threads/:id", async (c) => {
  const db = c.get("db");
  const owned = await db
    .select({ id: thread.id, runtime: thread.runtime })
    .from(thread)
    .innerJoin(project, eq(thread.projectId, project.id))
    .where(
      and(
        supportedThread,
        eq(thread.id, c.req.param("id")),
        eq(project.ownerId, c.get("user").id),
      ),
    )
    .get();
  if (!owned) return c.notFound();
  try {
    const sandbox = await runtime(c.env, c.get("user").id, owned);
    await sandbox.userDelete(owned.id);
  } catch (error) {
    return c.json(runtimeFailure(error, "delete"), 502);
  }
  await db.delete(thread).where(eq(thread.id, owned.id));
  return c.json({ deleted: true });
});

api.get("/activity", async (c) => {
  const owned = await c
    .get("db")
    .select({ id: thread.id, runtime: thread.runtime })
    .from(thread)
    .innerJoin(project, eq(thread.projectId, project.id))
    .where(and(eq(project.ownerId, c.get("user").id), supportedThread));
  if (!owned.length) return c.json({});
  try {
    const shared = owned.find((row) => row.runtime === "user");
    const runtimes = [
      ...(shared ? [shared] : []),
      ...owned.filter((row) => row.runtime === "computer"),
    ];
    const activity = Object.assign(
      {},
      ...(await Promise.all(
        runtimes.map(async (row) => {
          const sandbox = await runtime(c.env, c.get("user").id, row);
          const values = await sandbox.userActivity();
          return Object.fromEntries(
            owned
              .filter(
                (item) =>
                  item.runtime === row.runtime &&
                  (row.runtime === "user" || item.id === row.id) &&
                  values[item.id],
              )
              .map((item) => [item.id, values[item.id]]),
          );
        }),
      )),
    );
    return c.json(
      Object.fromEntries(
        owned
          .filter(({ id }) => activity[id])
          .map(({ id }) => [id, activity[id]]),
      ),
    );
  } catch {
    return c.json({ error: "Activity unavailable. Retrying…" }, 503);
  }
});

const acpAction = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("connect") }),
  z.strictObject({ type: z.literal("suspend") }),
  z.strictObject({ type: z.literal("authenticate") }),
  z.strictObject({
    type: z.literal("set-config"),
    configId: z.string().min(1).max(128),
    value: z.string().max(256),
  }),
  promptActionSchema,
  z.strictObject({ type: z.literal("cancel") }),
  z.strictObject({
    type: z.literal("permission"),
    id: z.string().min(1).max(256),
    optionId: z.string().min(1).max(256),
  }),
  z.strictObject({
    type: z.literal("login-response"),
    id: z.string().min(1).max(256),
    action: z.enum(["accept", "cancel"]),
  }),
  z.strictObject({ type: z.literal("logout") }),
]);

// Ownership and the global origin/session gates run before a sandbox stub is obtained.
api.get("/threads/:id/runtime/saved", async (c) => {
  const owned = await c
    .get("db")
    .select({ id: thread.id, runtime: thread.runtime })
    .from(thread)
    .innerJoin(project, eq(thread.projectId, project.id))
    .where(
      and(
        supportedThread,
        eq(thread.id, c.req.param("id")),
        eq(project.ownerId, c.get("user").id),
      ),
    )
    .get();
  if (!owned) return c.notFound();
  if (owned.runtime === "user" && !c.env.Sandboxes) return c.json(null);
  const sandbox = await runtime(c.env, c.get("user").id, owned);
  return c.json(await sandbox.userSaved(owned.id));
});

api.on(["GET", "POST"], "/threads/:id/runtime/acp", async (c) => {
  const owned = await c
    .get("db")
    .select({ id: thread.id, runtime: thread.runtime })
    .from(thread)
    .innerJoin(project, eq(thread.projectId, project.id))
    .where(
      and(
        supportedThread,
        eq(thread.id, c.req.param("id")),
        eq(project.ownerId, c.get("user").id),
      ),
    )
    .get();
  if (!owned) return c.notFound();
  let action: AcpAction | undefined;
  if (c.req.method === "POST") {
    const parsed = acpAction.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid ACP action." }, 400);
    action = parsed.data;
  }
  if (action?.type === "suspend" && owned.runtime !== "computer")
    return c.json(
      { error: "Explicit suspension is available for Computer threads." },
      409,
    );
  const sandbox = await runtime(c.env, c.get("user").id, owned, true);
  try {
    return c.json(await sandbox.userAcp(owned.id, action));
  } catch (error) {
    return c.json(runtimeFailure(error, "connect"), 409);
  }
});

// Resolve ownership before obtaining a Durable Object or contacting GitHub.
api.on(["GET", "POST"], "/threads/:id/runtime/:operation", async (c) => {
  const operation = c.req.param("operation");
  const method = c.req.method;
  if (
    !(
      method === "POST"
        ? ["start", "publish"]
        : ["status", "files", "file", "git", "diff", "review", "branch-diff"]
    ).includes(operation)
  )
    return c.notFound();
  const owned = await c
    .get("db")
    .select({
      id: thread.id,
      runtime: thread.runtime,
      repository: project.repository,
    })
    .from(thread)
    .innerJoin(project, eq(thread.projectId, project.id))
    .where(
      and(
        supportedThread,
        eq(thread.id, c.req.param("id")),
        eq(project.ownerId, c.get("user").id),
      ),
    )
    .get();
  if (!owned) return c.notFound();
  let path = "";
  if (["file", "diff", "branch-diff"].includes(operation)) {
    try {
      path = repositoryPath(c.req.query("path") ?? "");
    } catch {
      return c.json({ error: "Invalid repository path." }, 400);
    }
  }
  const sandbox = await runtime(c.env, c.get("user").id, owned, true);
  if (operation === "status") return c.json(await sandbox.userStatus(owned.id));
  if (operation === "publish") {
    const parsed = z
      .strictObject({
        revision: z.string().regex(/^[a-f0-9]{40}$/),
        title: z.string().trim().min(1).max(200),
        body: z.string().max(20000),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: "A reviewed snapshot and a title are required." },
        400,
      );
    const identity = await c
      .get("db")
      .select({ id: account.id })
      .from(account)
      .where(
        and(
          eq(account.userId, c.get("user").id),
          eq(account.providerId, "github"),
        ),
      )
      .get();
    if (!identity)
      return c.json({ error: "Reconnect your GitHub account." }, 403);
    const userToken = await createAuth(c.env).api.getAccessToken({
      headers: c.req.raw.headers,
      body: { accountId: identity.id },
    });
    const token = await repositoryWriteToken(
      c.env,
      owned.repository,
      userToken.accessToken,
    );
    try {
      const input = { ...parsed.data, branch: `agentflare/${owned.id}`, token };
      return c.json(await sandbox.userPublish(owned.id, input));
    } catch (error) {
      const safe = [
        "Publishing is already in progress.",
        "Start this thread first.",
        "The checkout changed. Review the latest changes before publishing.",
        "This branch has a closed PR or a different PR base. Start a new thread.",
        "The remote thread branch changed outside Agentflare. Publishing stopped; no force push was attempted.",
        "GitHub denied repository access. Install the GitHub App on this repository and reauthorize your account.",
        "GitHub rejected the publish. The branch may have changed, the PR may be closed, or repository rules may block it. Refresh before retrying.",
      ];
      return c.json(
        {
          error:
            error instanceof Error && safe.includes(error.message)
              ? error.message
              : "Publishing failed. Refresh and retry; any already-pushed commit will be reused. Check App permissions and the 4 MiB / 10000-file publish limits.",
        },
        409,
      );
    } finally {
      await github("/installation/token", token, undefined, "DELETE").catch(
        () => {},
      );
    }
  }
  if (operation === "start") {
    const identity = await c
      .get("db")
      .select({ id: account.id })
      .from(account)
      .where(
        and(
          eq(account.userId, c.get("user").id),
          eq(account.providerId, "github"),
        ),
      )
      .get();
    if (!identity)
      return c.json({ error: "Reconnect your GitHub account." }, 403);
    const token = await createAuth(c.env).api.getAccessToken({
      headers: c.req.raw.headers,
      body: { accountId: identity.id },
    });
    const cloneToken = await repositoryCloneToken(
      c.env,
      owned.repository,
      token.accessToken,
    );
    try {
      const input = {
        owner: c.get("user").id,
        repository: owned.repository,
        name: c.get("user").name,
        branch: `agentflare/${owned.id}`,
        cloneToken,
      };
      return c.json(await sandbox.userStart(owned.id, input));
    } catch (error) {
      return c.json(runtimeFailure(error, "start"), 502);
    }
  }
  try {
    if (operation === "review")
      return c.json(await sandbox.userReview(owned.id));
    return c.json(
      await sandbox.userInspect(
        owned.id,
        operation,
        path,
        c.req.query("staged") === "true",
      ),
    );
  } catch (error) {
    return c.json(runtimeFailure(error, "inspect"), 409);
  }
});
