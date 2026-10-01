import { headers } from "next/headers";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { env } from "cloudflare:workers";
import { getViewer } from "@/server/auth";
import { LandingPage } from "@/components/landing-page";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { alternates: { canonical: "/" } };

export default async function Home({ searchParams }: PageProps<"/">) {
  const session = await getViewer(env, await headers());
  if (session.user) redirect("/workspace");
  const params = await searchParams;
  return (
    <LandingPage
      configured={session.configured}
      hosted={env.HOSTED_MODE === "true"}
      initialError={
        session.denied
          ? "This account is no longer allowed on this installation. Contact the operator."
          : params.auth === "failed"
            ? "GitHub sign-in failed. Check that your account is allowed by this installation."
            : ""
      }
    />
  );
}
