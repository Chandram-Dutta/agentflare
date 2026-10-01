import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { env } from "cloudflare:workers";
import { getViewer } from "@/server/auth";
import { GitHubConnection } from "@/components/github-connection";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Connect GitHub",
  robots: { index: false, follow: false },
};

export default async function ConnectGitHubPage() {
  const session = await getViewer(env, await headers());
  if (!session.user) redirect("/");
  return <GitHubConnection />;
}
