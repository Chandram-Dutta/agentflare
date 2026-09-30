import { headers } from "next/headers";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { env } from "cloudflare:workers";
import { getViewer } from "@/server/auth";
import { Workspace } from "@/components/workspace";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Workspace",
  robots: { index: false, follow: false },
};

export default async function WorkspacePage() {
  const session = await getViewer(env, await headers());
  if (!session.user) redirect("/");
  return <Workspace user={session.user} />;
}
