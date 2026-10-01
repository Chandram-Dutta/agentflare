import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { env } from "cloudflare:workers";
import { getViewer } from "@/server/auth";
import { parseWorkspaceRoute } from "@/lib/workspace-route";
import { workspaceRouteExists } from "@/server/workspace-route";
import { WorkspaceContent } from "@/components/next-workspace";

export default async function WorkspaceDestination({
  params,
}: {
  params: Promise<{ path: string[] }>;
}) {
  const { path } = await params;
  const route = parseWorkspaceRoute(`/workspace/${path.join("/")}`);
  if (!route) notFound();
  const viewer = await getViewer(env, await headers());
  if (!viewer.user) redirect("/");
  if (!(await workspaceRouteExists(env, viewer.user.id, route))) notFound();
  return <WorkspaceContent />;
}
