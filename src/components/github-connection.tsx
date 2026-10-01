"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, Check, GitBranch, LoaderCircle } from "lucide-react";
import { apiRequest } from "@/lib/api-client";
import { Button } from "./ui/button";

export function GitHubConnection() {
  const [installUrl, setInstallUrl] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let inFlight = false;
    async function check() {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      setChecking(true);
      setError("");
      try {
        const result = await apiRequest<{
          connected: boolean;
          installUrl: string | null;
        }>("/github/connection", "GET", undefined, controller.signal);
        if (!active) return;
        if (result.connected) window.location.replace("/workspace");
        else setInstallUrl(result.installUrl);
      } catch (cause) {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not check GitHub access.",
          );
      } finally {
        inFlight = false;
        if (active) setChecking(false);
      }
    }
    void check();
    const onFocus = () => {
      void check();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    const interval = waiting ? window.setInterval(onFocus, 5000) : undefined;
    return () => {
      active = false;
      controller.abort();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      window.clearInterval(interval);
    };
  }, [attempt, waiting]);

  async function signOut() {
    try {
      await apiRequest("/auth/sign-out", "POST", {});
      // Re-run the page's server-side session guard after clearing the session.
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-out failed.");
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center gap-6 px-6 py-12">
      <div className="text-sm">
        agentflare<span className="text-primary">_</span>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Check className="size-4" /> GitHub account connected
      </div>
      <div>
        <h1 className="text-2xl">Connect your repositories</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          One more step: install the Agentflare GitHub App and choose which
          repositories it can access.
        </p>
        <p className="mt-3 text-xs text-muted-foreground">
          Signing in verifies your identity. Installing the App lets Agentflare
          clone your selected repositories and publish pull requests.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {installUrl && (
          <a
            href={installUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setWaiting(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground"
          >
            <GitBranch className="size-4" /> Install GitHub App{" "}
            <ArrowUpRight className="size-4" />
          </a>
        )}
        <Button
          variant="outline"
          disabled={checking}
          onClick={() => setAttempt((value) => value + 1)}
        >
          {checking && <LoaderCircle className="size-4 animate-spin" />}
          {checking ? "Checking access…" : "Check access"}
        </Button>
      </div>
      <p role="status" className="text-xs text-muted-foreground">
        {waiting
          ? "Finish installation in the GitHub tab, then return here. We’ll continue automatically once access is verified. Organization approval requests may need an owner’s approval first."
          : "GitHub opens in a new tab. Select your personal account or an organization you manage."}
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button
        variant="link"
        className="self-start px-0 text-xs"
        onClick={signOut}
      >
        Sign out / use another account
      </Button>
    </main>
  );
}
