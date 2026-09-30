"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ThemeProvider, useTheme } from "next-themes";
import { Moon, Plus, Sun } from "lucide-react";
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
} from "react-resizable-panels";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { RuntimeWorkspace } from "@/components/runtime-workspace";
import { ProjectSettings } from "@/components/project-settings";
import { apiRequest } from "@/lib/api-client";
import {
  agents,
  type AgentId,
  type Project,
  type Thread,
  type WorkspaceData,
} from "@/lib/workspace";

type Session = {
  configured: boolean;
  user: { id: string; name: string } | null;
};

export function Workspace() {
  return (
    <ThemeProvider
      attribute="class"
      storageKey="agentflare-theme"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <WorkspaceContent />
    </ThemeProvider>
  );
}

function WorkspaceContent() {
  const { resolvedTheme, setTheme } = useTheme();
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void apiRequest<Session>("/session")
      .then((result) => {
        if (cancelled) return;
        setSession(result);
        if (
          new URLSearchParams(window.location.search).get("auth") === "failed"
        ) {
          setError(
            "GitHub sign-in failed. Check that your account is allowed by this installation.",
          );
        }
      })
      .catch((error: Error) => {
        if (!cancelled) setError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function signIn() {
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

  async function signOut() {
    setPending(true);
    setError("");
    try {
      await apiRequest("/auth/sign-out", "POST", {});
      setSession({ configured: true, user: null });
    } catch (error) {
      setError(error instanceof Error ? error.message : "Sign-out failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
        <h1 className="text-sm font-normal">
          agentflare<span className="text-primary">_</span>
        </h1>
        <div className="flex min-w-0 items-center gap-3">
          {session?.user && (
            <>
              <span className="max-w-32 truncate text-[11px] text-muted-foreground">
                {session.user.name}
              </span>
              <Button
                variant="ghost"
                className="h-7 rounded-none text-xs font-normal"
                disabled={pending}
                onClick={signOut}
              >
                sign out
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            className="rounded-none"
            aria-label="Toggle color theme"
            title="Toggle color theme"
            onClick={() =>
              setTheme(resolvedTheme === "dark" ? "light" : "dark")
            }
          >
            <Moon className="size-4 dark:hidden" aria-hidden="true" />
            <Sun className="hidden size-4 dark:block" aria-hidden="true" />
          </Button>
        </div>
      </header>
      {error && (
        <div className="flex items-center justify-between gap-4 border-b px-4 py-3 text-xs">
          <p role="alert" className="text-destructive">
            {error}
          </p>
          <Button
            variant="ghost"
            className="rounded-none text-xs"
            onClick={() => window.location.reload()}
          >
            reload
          </Button>
        </div>
      )}
      {session?.user ? (
        <SavedWorkspace />
      ) : (
        <main className="mx-auto mt-16 w-full max-w-lg px-6 text-xs sm:mt-28">
          {!session ? (
            <p role="status" className="text-muted-foreground">
              {error
                ? "Unable to load this installation."
                : "loading workspace…"}
            </p>
          ) : !session.configured ? (
            <>
              <h2 className="font-normal">installation setup required</h2>
              <p className="mt-3 leading-6 text-muted-foreground">
                Configure D1, a GitHub OAuth app, the authentication secret and
                allowed GitHub IDs before signing in.
              </p>
              <p className="mt-3 leading-6 text-muted-foreground">
                See the self-hosting instructions in the repository README.
                Credentials belong in Worker secrets or your local .dev.vars,
                never here.
              </p>
            </>
          ) : (
            <>
              <h2 className="font-normal">sign in to your workspace</h2>
              <p className="mt-3 leading-6 text-muted-foreground">
                Use an account allowed by this installation. Repository access
                and agent credentials are separate from sign-in.
              </p>
              <Button
                variant="outline"
                className="mt-5 rounded-none text-xs font-normal"
                disabled={pending}
                onClick={signIn}
              >
                {pending ? "connecting…" : "continue with GitHub"}
              </Button>
            </>
          )}
        </main>
      )}
    </div>
  );
}

function SavedWorkspace() {
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void apiRequest<WorkspaceData>("/workspace")
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((error: Error) => {
        if (!cancelled) setError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function savedProject(project: Project) {
    setData(
      (current) =>
        current && {
          ...current,
          projects: current.projects.some((p) => p.id === project.id)
            ? current.projects.map((p) => (p.id === project.id ? project : p))
            : [...current.projects, project],
        },
    );
    setSelected(project.id);
  }
  function savedThread(thread: Thread) {
    setData(
      (current) =>
        current && {
          ...current,
          threads: current.threads.some((t) => t.id === thread.id)
            ? current.threads.map((t) => (t.id === thread.id ? thread : t))
            : [...current.threads, thread],
        },
    );
  }
  if (error)
    return (
      <main className="p-6 text-xs">
        <p role="alert" className="text-destructive">
          {error}
        </p>
        <Button
          variant="outline"
          className="mt-4 rounded-none text-xs"
          onClick={() => window.location.reload()}
        >
          reload
        </Button>
      </main>
    );
  if (!data)
    return (
      <p role="status" className="p-6 text-xs text-muted-foreground">
        loading projects…
      </p>
    );
  const active =
    data.projects.find((p) => p.id === selected)?.id ??
    data.projects[0]?.id ??
    "";
  return (
    <Tabs
      value={active}
      onValueChange={(value) => setSelected(String(value))}
      className="work-tabs flex-1 gap-0"
    >
      <div className="flex min-w-0 items-center border-b">
        {data.projects.length > 0 && (
          <TabsList
            variant="line"
            aria-label="Projects"
            className="min-w-0 justify-start overflow-x-auto"
          >
            {data.projects.map((project) => (
              <TabsTrigger key={project.id} value={project.id}>
                {project.name}
              </TabsTrigger>
            ))}
          </TabsList>
        )}
        <div className="mx-2">
          <ProjectSettings onSave={savedProject} />
        </div>
      </div>
      {data.projects.length === 0 && (
        <main className="p-6 text-xs">
          <h2 className="font-normal">no projects yet</h2>
          <p className="mt-2 text-muted-foreground">
            Add a repository using + project. Your projects are private to your
            account.
          </p>
        </main>
      )}
      {data.projects.map((project) => (
        <TabsContent
          key={project.id}
          value={project.id}
          keepMounted
          className="flex min-h-0 flex-col data-[hidden]:hidden"
        >
          <ProjectWorkspace
            project={project}
            active={active === project.id}
            threads={data.threads.filter((t) => t.projectId === project.id)}
            onProjectSave={savedProject}
            onThreadSave={savedThread}
          />
        </TabsContent>
      ))}
    </Tabs>
  );
}

function ProjectWorkspace({
  project,
  active,
  threads,
  onProjectSave,
  onThreadSave,
}: {
  project: Project;
  active: boolean;
  threads: Thread[];
  onProjectSave: (project: Project) => void;
  onThreadSave: (thread: Thread) => void;
}) {
  const [selected, setSelected] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const thread = threads.find((item) => item.id === selected) ?? threads[0];
  const layout = useDefaultLayout({
    id: `agentflare-panes-${project.id}`,
    onlySaveAfterUserInteractions: true,
  });

  async function addThread() {
    setPending(true);
    setError("");
    try {
      const result = await apiRequest<Thread>(
        `/projects/${project.id}/threads`,
        "POST",
        { name: `thread ${threads.length + 1}`, agent: "codex" },
      );
      onThreadSave(result);
      setSelected(result.id);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to create thread.",
      );
    } finally {
      setPending(false);
    }
  }

  if (!active) return null;

  return (
    <div className="min-w-0 flex-1 overflow-x-auto">
      <Group
        orientation="horizontal"
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={layout.onLayoutChanged}
        className="min-h-[480px] min-w-[1100px]"
        style={{ height: "calc(100dvh - 89px)" }}
        aria-label="Workspace panes"
      >
        <Panel id={`${project.id}-threads`} defaultSize="14%" minSize="160px">
          <aside
            className="flex h-full min-w-0 flex-col"
            aria-label={`${project.name} threads`}
          >
            <div className="flex h-10 items-center justify-between border-b px-4">
              <h2 className="text-xs font-normal">threads</h2>
              <Button
                variant="ghost"
                size="icon-xs"
                className="rounded-none"
                aria-label="New thread"
                disabled={pending}
                onClick={addThread}
              >
                <Plus className="size-3.5" />
              </Button>
            </div>
            <nav
              aria-label="Threads"
              className="flex min-h-0 flex-col gap-1 overflow-auto p-2"
            >
              {threads.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-current={item.id === thread?.id ? "true" : undefined}
                  onClick={() => setSelected(item.id)}
                  className={`min-w-32 border-l-2 px-3 py-2 text-left text-xs outline-offset-2 focus-visible:outline-primary lg:min-w-0 ${item.id === thread?.id ? "border-primary bg-[var(--terminal)]" : "border-transparent text-muted-foreground hover:bg-[var(--terminal)]"}`}
                >
                  <span className="block truncate">{item.name}</span>
                  <span className="mt-1 block text-[10px] text-muted-foreground">
                    {agents[item.agent].name}
                  </span>
                </button>
              ))}
            </nav>
            {error && (
              <p
                role="alert"
                className="px-4 py-2 text-[11px] text-destructive"
              >
                {error}
              </p>
            )}
            <div className="mt-auto border-t p-3">
              <ProjectSettings project={project} onSave={onProjectSave} />
              <p
                className="mt-2 truncate text-[10px] leading-4 text-muted-foreground"
                title={project.repository}
              >
                {project.repository.replace("https://github.com/", "")}
              </p>
            </div>
          </aside>
        </Panel>
        <Separator
          className="workspace-divider"
          aria-label="Resize threads and agent conversation"
        />
        <RuntimeWorkspace
          key={thread?.id ?? "empty"}
          threadId={thread?.id}
          projectId={project.id}
        >
          {(started) =>
            thread ? (
              <ThreadControls
                key={`${thread.id}:${thread.version}`}
                thread={thread}
                onSave={onThreadSave}
                started={started}
              />
            ) : (
              <div className="h-10 border-b px-3 py-3 text-xs">
                agent conversation
              </div>
            )
          }
        </RuntimeWorkspace>
      </Group>
    </div>
  );
}

function ThreadControls({
  thread,
  onSave,
  started,
}: {
  thread: Thread;
  onSave: (thread: Thread) => void;
  started: boolean;
}) {
  const [name, setName] = useState(thread.name);
  const [agent, setAgent] = useState<AgentId>(thread.agent);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const dirty = name !== thread.name || agent !== thread.agent;
  async function save(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      onSave(
        await apiRequest<Thread>(`/threads/${thread.id}`, "PATCH", {
          name,
          agent,
          version: thread.version,
        }),
      );
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to save thread.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="border-b">
      <form
        onSubmit={save}
        className="flex min-h-10 flex-wrap items-center justify-between gap-2 px-3 py-1"
      >
        <div className="flex min-w-0 basis-full items-center gap-2 sm:flex-1 sm:basis-auto">
          <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
            {thread.agent === "codex" ? "conversation /" : "terminal /"}
          </span>
          <Input
            aria-label="Thread name"
            value={name}
            required
            maxLength={60}
            disabled={pending}
            onChange={(event) => setName(event.target.value)}
            className="workspace-input h-7! min-w-0 max-w-52 border-transparent px-1"
          />
        </div>
        <select
          aria-label="Thread agent"
          value={agent}
          disabled={pending || started}
          onChange={(event) => setAgent(event.target.value as AgentId)}
          className="h-7 max-w-full border bg-background px-2 text-xs outline-offset-2 focus-visible:outline-primary"
        >
          {thread.agent === "claude" && (
            <option value="claude">{agents.claude.name}</option>
          )}
          <option value="codex">{agents.codex.name}</option>
        </select>
        {dirty && (
          <Button
            type="submit"
            variant="outline"
            disabled={pending}
            className="h-7 rounded-none text-xs font-normal"
          >
            {pending ? "saving…" : "save thread"}
          </Button>
        )}
      </form>
      {error && (
        <p role="alert" className="px-3 pb-2 text-[11px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
