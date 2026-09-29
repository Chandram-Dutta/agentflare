import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { agents, workspaceConfig } from "@/lib/workspace";

export const api = new Hono().basePath("/api");

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
