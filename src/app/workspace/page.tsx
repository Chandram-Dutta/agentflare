import { headers } from "next/headers";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { env } from "cloudflare:workers";
import { getViewer, getGitHubConnection } from "@/server/auth";
import { Workspace } from "@/components/workspace";
import { GitHubConnection } from "@/components/github-connection";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Workspace",
  robots: { index: false, follow: false },
};

export default async function WorkspacePage() {
  const session = await getViewer(env, await headers());
  if (!session.user) redirect("/");
  let connected = false;
  try {
    connected = (
      await getGitHubConnection(env, await headers(), session.user.id)
    ).connected;
  } catch {
    return <GitHubConnection />;
  }
  if (!connected) redirect("/connect/github");
  return <Workspace user={session.user} />;
}
