import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "cloudflare:workers";
import { getViewer } from "@/server/auth";
import { Workspace } from "@/components/workspace";

export const dynamic = "force-dynamic";

export default async function WorkspacePage() {
  const session = await getViewer(env, await headers());
  if (!session.user) redirect("/");
  return <Workspace user={session.user} />;
}
