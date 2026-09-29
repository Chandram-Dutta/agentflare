"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Box,
  Check,
  Command,
  GitBranch,
  GitFork,
  SquareTerminal,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TerminalPreview } from "@/components/terminal-preview";
import { agents, type AgentId } from "@/lib/workspace";

export function Workspace() {
  const [agent, setAgent] = useState<AgentId>("claude");
  const [repository, setRepository] = useState("");
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(
    null,
  );
  const [pending, setPending] = useState(false);

  async function checkConfiguration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setResult(null);
    try {
      const response = await fetch("/api/workspace-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repository, agent }),
      });
      if (!response.ok) {
        setResult({
          ok: false,
          message:
            "Use a GitHub repository root URL without credentials, query parameters or a subpath.",
        });
      } else {
        setResult({
          ok: true,
          message:
            "Configuration format checked. Repository access and agent credentials have not been checked. Nothing has been launched.",
        });
      }
    } catch {
      setResult({ ok: false, message: "Could not reach the API. Try again." });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-16 items-center justify-between border-b px-5 md:px-9">
        <Link
          href="/"
          className="flex items-center gap-2.5 text-lg font-semibold tracking-tight"
        >
          <Zap
            className="size-5 fill-primary text-primary"
            aria-hidden="true"
          />
          agentflare
        </Link>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="hidden sm:inline">Development workspaces</span>
          <span className="rounded-md border px-2 py-1 font-mono text-[10px] tracking-wider">
            LOCAL PREVIEW
          </span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1500px] flex-1 px-5 py-9 md:px-9 md:py-12">
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="mb-3 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.15em] text-muted-foreground">
              <Box className="size-3.5" />
              New workspace
            </div>
            <h1 className="text-3xl font-medium tracking-tight">
              Your agent. Your terminal.
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Bring a repository. Pick a CLI. Work the way you already do.
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="size-1.5 rounded-full bg-amber-400" />
            No sandbox connected
          </div>
        </div>

        <div className="grid overflow-hidden rounded-xl border bg-[#151619] lg:grid-cols-[320px_minmax(0,1fr)]">
          <section
            className="border-b bg-[#18191c] p-6 lg:border-r lg:border-b-0"
            aria-labelledby="setup-heading"
          >
            <h2 id="setup-heading" className="text-sm font-medium">
              Workspace configuration
            </h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              The environment around your agent.
            </p>
            <form onSubmit={checkConfiguration} className="mt-7 space-y-7">
              <div className="space-y-2.5">
                <Label htmlFor="repository" className="text-xs">
                  <GitFork className="size-3.5" />
                  Repository
                </Label>
                <Input
                  id="repository"
                  required
                  type="url"
                  value={repository}
                  disabled={pending}
                  onChange={(event) => {
                    setRepository(event.target.value);
                    setResult(null);
                  }}
                  placeholder="https://github.com/owner/repo"
                  className="h-10 text-xs"
                  aria-describedby="repository-help"
                />
                <p
                  id="repository-help"
                  className="text-[11px] leading-5 text-muted-foreground"
                >
                  GitHub is not connected yet. This checks the URL format only.
                </p>
              </div>
              <fieldset disabled={pending}>
                <legend className="mb-3 text-xs font-medium">CLI agent</legend>
                <div className="space-y-2">
                  {Object.entries(agents).map(([id, item]) => (
                    <label
                      key={id}
                      className={`relative flex cursor-pointer items-center gap-3 rounded-lg border p-3 has-focus-visible:ring-2 has-focus-visible:ring-primary ${agent === id ? "border-primary/50 bg-primary/5" : "border-border hover:bg-white/[0.02]"}`}
                    >
                      <input
                        className="sr-only"
                        type="radio"
                        name="agent"
                        value={id}
                        checked={agent === id}
                        onChange={() => {
                          setAgent(id as AgentId);
                          setResult(null);
                        }}
                      />
                      <Command
                        className={`size-4 ${agent === id ? "text-primary" : "text-muted-foreground"}`}
                      />
                      <div className="flex-1">
                        <div className="text-xs font-medium">{item.name}</div>
                        <div className="mt-0.5 text-[10px] text-muted-foreground">
                          {item.description}
                        </div>
                      </div>
                      {agent === id && (
                        <Check className="size-3.5 text-primary" />
                      )}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="flex items-center justify-between rounded-md border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
                <span>Native entrypoint</span>
                <code className="text-foreground">{agents[agent].command}</code>
              </div>
              <div className="space-y-3">
                <Button
                  type="submit"
                  className="h-10 w-full"
                  disabled={pending}
                >
                  {pending ? "Checking…" : "Check configuration"}
                  <ArrowRight className="size-4" />
                </Button>
                <p className="text-center text-[10px] text-muted-foreground">
                  No provisioning, API usage or charges.
                </p>
              </div>
              {result && (
                <p
                  role={result.ok ? "status" : "alert"}
                  className={`text-xs leading-5 ${result.ok ? "text-emerald-300" : "text-red-300"}`}
                >
                  {result.message}
                </p>
              )}
            </form>
          </section>

          <section
            className="flex min-w-0 flex-col"
            aria-labelledby="terminal-heading"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
              <h2
                id="terminal-heading"
                className="flex items-center gap-2 text-xs font-medium"
              >
                <SquareTerminal className="size-4 text-primary" />
                Terminal
              </h2>
              <span className="font-mono text-[10px] text-muted-foreground">
                ghostty-web / renderer preview
              </span>
            </div>
            <TerminalPreview />
          </section>
        </div>

        <div className="mt-6 grid gap-5 text-xs text-muted-foreground sm:grid-cols-3">
          <p className="flex gap-2.5 leading-5">
            <SquareTerminal className="mt-0.5 size-4 shrink-0" />
            <span>
              <strong className="font-medium text-foreground">
                Native CLI experience
              </strong>
              <br />
              The agent owns the conversation.
            </span>
          </p>
          <p className="flex gap-2.5 leading-5">
            <Box className="mt-0.5 size-4 shrink-0" />
            <span>
              <strong className="font-medium text-foreground">
                Isolated workspace
              </strong>
              <br />
              Cloudflare provisioning is next.
            </span>
          </p>
          <p className="flex gap-2.5 leading-5">
            <GitBranch className="mt-0.5 size-4 shrink-0" />
            <span>
              <strong className="font-medium text-foreground">
                Review before publishing
              </strong>
              <br />
              Git integration is not connected.
            </span>
          </p>
        </div>
      </main>
      <footer className="flex justify-between border-t px-5 py-4 font-mono text-[10px] text-muted-foreground md:px-9">
        <span>AGENTFLARE / FOUNDATION</span>
        <span>Nothing running. Nothing pushed.</span>
      </footer>
    </div>
  );
}
