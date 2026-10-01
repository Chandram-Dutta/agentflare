import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { project, thread } from "./db/workspace-schema";
import type { Bindings } from "./env";
import type { WorkspaceRoute } from "@/lib/workspace-route";

export async function workspaceRouteExists(
  env: Bindings,
  userId: string,
  route: WorkspaceRoute,
) {
  if (!route.projectId) return true;
  const db = drizzle(env.DB!);
  const owned = await db
    .select({ id: project.id })
    .from(project)
    .where(and(eq(project.id, route.projectId), eq(project.ownerId, userId)))
    .get();
  if (!owned) return false;
  if (!route.changeId) return true;
  return Boolean(
    await db
      .select({ id: thread.id })
      .from(thread)
      .where(
        and(
          eq(thread.id, route.changeId),
          eq(thread.projectId, owned.id),
          eq(thread.runtime, "user"),
          eq(thread.agent, "codex"),
        ),
      )
      .get(),
  );
}
