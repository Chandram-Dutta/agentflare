"use client";

import { ArrowUpRight, ChevronRight, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import Link from "next/link";
import { useState } from "react";
import { Button } from "./ui/button";
import { apiRequest } from "@/lib/api-client";

const github = "https://github.com/Chandram-Dutta/agentflare";

export function LandingPage({
  configured,
  initialError = "",
}: {
  configured: boolean;
  initialError?: string;
}) {
  const { resolvedTheme, setTheme } = useTheme();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(initialError);
  const disabled = !configured || pending;
  async function onSignIn() {
    setPending(true);
    setError("");
    try {
      const { url } = await apiRequest<{ url: string }>(
        "/auth/sign-in/social",
        "POST",
        {},
      );
      window.location.assign(url);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Sign-in failed.");
      setPending(false);
    }
  }
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[920px] flex-col px-6 leading-[1.7] sm:px-10">
      <a
        href="#main"
        className="absolute -top-24 left-5 z-10 bg-background p-2 focus:top-2"
      >
        Skip to content
      </a>
      <header className="flex min-h-22 flex-wrap items-center justify-between gap-x-5 gap-y-2 border-b py-5 sm:min-h-28">
        <Link
          href="/"
          aria-label="Agentflare home"
          className="text-lg tracking-[-1px] sm:text-xl"
        >
          agentflare
          <span className="text-primary" aria-hidden="true">
            _
          </span>
        </Link>
        <nav
          aria-label="Main navigation"
          className="flex items-center gap-2 text-xs sm:gap-4"
        >
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Toggle color theme"
            title="Toggle color theme"
            onClick={() =>
              setTheme(resolvedTheme === "dark" ? "light" : "dark")
            }
          >
            <Moon className="size-4 dark:hidden" aria-hidden="true" />
            <Sun className="hidden size-4 dark:block" aria-hidden="true" />
          </Button>
          <a
            href={github}
            className="inline-flex items-center gap-1 hover:text-primary"
          >
            GitHub <ArrowUpRight size={14} aria-hidden="true" />
          </a>
          <Button
            variant="ghost"
            className="rounded-md text-xs font-normal"
            disabled={disabled}
            onClick={onSignIn}
          >
            Sign in
          </Button>
        </nav>
      </header>
      <main id="main" className="flex-1">
        <section
          aria-labelledby="headline"
          className="pb-9 pt-12 sm:pb-12 sm:pt-[70px]"
        >
          <p className="mb-6 flex items-center gap-3 text-xs text-primary">
            <span
              className="size-1.5 rounded-full bg-primary"
              aria-hidden="true"
            />
            In alpha
          </p>
          <h1
            id="headline"
            className="text-[clamp(28px,4.2vw,44px)] font-normal leading-[1.3] tracking-[-1px] sm:tracking-[-1.8px]"
          >
            Your coding agent.
            <br />
            In your browser.
          </h1>
          <p className="my-[26px] max-w-[700px] text-sm leading-[1.8] sm:text-base">
            Open a repository, work with Codex in a Cloudflare sandbox, and
            review the changes. Your agent, files, and Git in one workspace.
          </p>
          <div className="flex flex-wrap items-center gap-5">
            <Button
              className="rounded-md px-4 font-normal"
              disabled={disabled}
              onClick={onSignIn}
            >
              Sign up with GitHub <ArrowUpRight size={15} aria-hidden="true" />
            </Button>
            <a
              href={github}
              className="inline-flex items-center gap-2 border-b border-primary pb-1 text-xs hover:text-primary"
            >
              Source on GitHub <ArrowUpRight size={15} aria-hidden="true" />
            </a>
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            Sign in or create an account with GitHub. Each account has its own
            private workspace.
          </p>
          {pending && (
            <p role="status" className="mt-3 text-xs text-muted-foreground">
              Connecting to GitHub…
            </p>
          )}
          {configured === false && (
            <div className="mt-5 border-l-2 border-primary pl-4 text-xs">
              <h2 className="font-normal">Installation setup required</h2>
              <p className="mt-2 text-muted-foreground">
                Configure D1, a GitHub App, and the authentication secret before
                signing in. See the{" "}
                <a
                  href={`${github}#readme`}
                  className="underline underline-offset-4"
                >
                  self-hosting instructions
                </a>
                . Credentials belong in Worker secrets or your local .dev.vars,
                never here.
              </p>
            </div>
          )}
          {error && (
            <div className="mt-5 text-xs">
              <p role="alert" className="text-destructive">
                {error}
              </p>
              <Button
                variant="link"
                className="mt-1 px-0 text-xs"
                onClick={() => window.location.reload()}
              >
                Retry
              </Button>
            </div>
          )}
        </section>
        <figure className="border bg-[var(--terminal)]">
          <figcaption className="flex justify-between gap-3 border-b px-5 py-3 text-[11px]">
            <span>Workspace example</span>
            <span
              className="hidden text-muted-foreground sm:inline"
              aria-hidden="true"
            >
              ~/you/project
            </span>
          </figcaption>
          <div className="px-5 pb-[18px] pt-6 text-[13px]">
            <dl>
              {[
                ["Repository", "you/project"],
                ["Branch", "work/example"],
                ["Agent", "Codex"],
              ].map(([label, value]) => (
                <div key={label} className="flex gap-5">
                  <dt className="w-[95px] text-muted-foreground">{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <div
              className="mt-[22px] flex items-center gap-2"
              aria-hidden="true"
            >
              <ChevronRight size={15} className="text-primary" />
              <span>▂</span>
            </div>
          </div>
        </figure>
        <p className="mb-9 mt-3.5 text-[11px] text-muted-foreground sm:mb-12">
          A workspace around your agent. Open source and self-hostable.
        </p>
      </main>
      <footer className="flex flex-wrap justify-between gap-4 border-t pb-8 pt-[22px] text-[11px] text-muted-foreground">
        <span>Built on Cloudflare.</span>
        <a
          href={github}
          className="inline-flex items-center gap-1 hover:text-primary"
        >
          Follow development <ArrowUpRight size={13} aria-hidden="true" />
        </a>
      </footer>
    </div>
  );
}
