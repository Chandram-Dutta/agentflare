import { headers } from "next/headers";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { env } from "cloudflare:workers";
import { getViewer, getGitHubConnection } from "@/server/auth";
import { NextWorkspace } from "@/components/next-workspace";
import { GitHubConnection } from "@/components/github-connection";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Workspace",
  robots: { index: false, follow: false },
};

export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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
  return <NextWorkspace user={session.user}>{children}</NextWorkspace>;
}
