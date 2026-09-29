import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { and, asc, eq, getTableColumns, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  agents,
  projectInput,
  projectUpdate,
  threadInput,
  threadUpdate,
  workspaceConfig,
} from "@/lib/workspace";
import { createAuth } from "./auth";
import { allowedGitHubIds, installationReady, type Bindings } from "./env";
import { account } from "./db/auth-schema";
import { project, thread } from "./db/workspace-schema";

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
  if (error instanceof HTTPException) return error.getResponse();
  return c.json(
    {
      error:
        "Request failed. Check the installation's database and configuration.",
    },
    500,
  );
});

api.get("/health", (c) => c.json({ status: "ok", execution: "not-connected" }));

// Public, side-effect-free format validation. Does not fetch, clone or execute.
// Authentication and repository authorization must precede any future launch API.
api.post("/workspace-config", bodyLimit({ maxSize: 4096 }), async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request must contain valid JSON." }, 400);
  }

  const parsed = workspaceConfig.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Choose a supported agent and a GitHub repository root URL." },
      400,
    );
  }

  return c.json({
    ...parsed.data,
    command: agents[parsed.data.agent].command,
    execution: "not-connected",
  });
});

// Deliberately expose only sign-in/callback/sign-out, not token retrieval or
// account-management endpoints. Login tokens are not repository credentials.
api.on(["GET", "POST"], "/auth/*", bodyLimit({ maxSize: 8192 }), async (c) => {
  if (!installationReady(c.env))
    return c.json({ error: "Installation setup is required." }, 503);
  const path = c.req.path;
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
          callbackURL: `${c.env.BETTER_AUTH_URL}/`,
          errorCallbackURL: `${c.env.BETTER_AUTH_URL}/?auth=failed`,
          disableRedirect: true,
        }),
      }),
    );
  }
  return createAuth(c.env).handler(c.req.raw);
});

api.get("/session", async (c) => {
  if (!installationReady(c.env))
    return c.json({ configured: false, user: null });
  const session = await createAuth(c.env).api.getSession({
    headers: c.req.raw.headers,
  });
  if (!session) return c.json({ configured: true, user: null });
  const db = drizzle(c.env.DB!);
  const identity = await db
    .select({ id: account.accountId })
    .from(account)
    .where(
      and(
        eq(account.userId, session.user.id),
        eq(account.providerId, "github"),
      ),
    )
    .get();
  if (!identity || !allowedGitHubIds(c.env).has(identity.id))
    return c.json(
      { error: "This account is no longer allowed on this installation." },
      403,
    );
  return c.json({
    configured: true,
    user: { id: session.user.id, name: session.user.name },
  });
});

// All routes below require both a valid session and current operator admission.
api.use("*", bodyLimit({ maxSize: 4096 }), async (c, next) => {
  if (!installationReady(c.env))
    return c.json({ error: "Installation setup is required." }, 503);
  if (
    !["GET", "HEAD"].includes(c.req.method) &&
    c.req.header("Origin") !== c.env.BETTER_AUTH_URL
  ) {
    return c.json({ error: "Origin is not allowed." }, 403);
  }
  const session = await createAuth(c.env).api.getSession({
    headers: c.req.raw.headers,
  });
  if (!session) return c.json({ error: "Sign in to continue." }, 401);
  const db = drizzle(c.env.DB!);
  const identity = await db
    .select({ id: account.accountId })
    .from(account)
    .where(
      and(
        eq(account.userId, session.user.id),
        eq(account.providerId, "github"),
      ),
    )
    .get();
  if (!identity || !allowedGitHubIds(c.env).has(identity.id))
    return c.json(
      { error: "This account is not allowed on this installation." },
      403,
    );
  c.set("user", { id: session.user.id, name: session.user.name });
  c.set("db", db);
  await next();
});

const projectFields = {
  id: project.id,
  name: project.name,
  repository: project.repository,
  version: project.version,
  createdAt: project.createdAt,
};

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
      .where(owner)
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
      agent: input.data.agent,
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
