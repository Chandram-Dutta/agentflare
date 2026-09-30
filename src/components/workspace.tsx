"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useTheme } from "next-themes";
import { createPortal } from "react-dom";
import {
  Moon,
  Plus,
  Sun,
  Trash2,
  ListTree,
  Bot,
  FileDiff,
  FolderGit2,
  LogOut,
  MessageSquare,
} from "lucide-react";
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
  useGroupRef,
} from "react-resizable-panels";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { RuntimeWorkspace } from "@/components/runtime-workspace";
import {
  ThreadStateProvider,
  ThreadActivity,
  useThreadStore,
} from "./thread-state";
import { ProjectSettings } from "@/components/project-settings";
import type { Viewer } from "@/server/auth";
import { apiRequest } from "@/lib/api-client";
import {
  agents,
  type Project,
  type Thread,
  type WorkspaceData,
} from "@/lib/workspace";

export function Workspace({ user }: { user: Viewer }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    setError("");
    try {
      await apiRequest("/auth/sign-out", "POST", {});
      window.location.replace("/");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Sign-out failed.");
    } finally {
      setPending(false);
    }
  }

  function renderHeader(projects?: ReactNode) {
    return (
      <header className="flex h-12 min-w-0 shrink-0 items-center gap-3 border-b px-3">
        <h1 className="shrink-0 text-sm font-normal">
          agentflare<span className="text-primary">_</span>
        </h1>
        <div className="flex min-w-0 flex-1 items-center gap-1">{projects}</div>
        <div className="flex shrink-0 items-center gap-1 text-muted-foreground">
          {user && (
            <>
              <span className="mr-2 hidden max-w-24 truncate text-[11px] lg:block">
                {user.name}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="rounded-md"
                aria-label="Sign out"
                title="Sign out"
                disabled={pending}
                onClick={signOut}
              >
                <LogOut className="size-3.5" aria-hidden="true" />
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            className="rounded-md"
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
    );
  }

  return (
    <div className="workspace-shell flex min-h-dvh flex-col">
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
      <ThreadStateProvider>
        <SavedWorkspace renderHeader={renderHeader} />
      </ThreadStateProvider>
    </div>
  );
}

function SavedWorkspace({
  renderHeader,
}: {
  renderHeader: (projects?: ReactNode) => ReactNode;
}) {
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [selected, setSelected] = useState("");
  const [paneControls, setPaneControls] = useState<HTMLDivElement | null>(null);
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
      <>
        {renderHeader()}
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
      </>
    );
  if (!data)
    return (
      <>
        {renderHeader()}
        <p role="status" className="p-6 text-xs text-muted-foreground">
          loading projects…
        </p>
      </>
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
      {renderHeader(
        <>
          {data.projects.length > 0 && (
            <TabsList
              variant="line"
              aria-label="Projects"
              className="project-tabs min-w-0 justify-start overflow-x-auto"
            >
              {data.projects.map((project) => (
                <TabsTrigger key={project.id} value={project.id}>
                  {project.name}
                  <ThreadActivity
                    compact
                    ids={data.threads
                      .filter(
                        (t) =>
                          t.projectId === project.id && t.runtime === "user",
                      )
                      .map((t) => t.id)}
                  />
                </TabsTrigger>
              ))}
            </TabsList>
          )}
          <div className="shrink-0">
            <ProjectSettings onSave={savedProject} />
          </div>
          <div
            ref={setPaneControls}
            className="ml-auto flex shrink-0 items-center"
          />
        </>,
      )}
      {data.projects.length === 0 && (
        <main className="p-6 text-xs">
          <h2 className="font-normal">no projects yet</h2>
          <p className="mt-2 text-muted-foreground">
            Add a repository using the + button. Your projects are private to
            your account.
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
            paneControls={paneControls}
            active={active === project.id}
            threads={data.threads.filter((t) => t.projectId === project.id)}
            onProjectSave={savedProject}
            onThreadSave={savedThread}
            onThreadDelete={(id) =>
              setData(
                (current) =>
                  current && {
                    ...current,
                    threads: current.threads.filter((t) => t.id !== id),
                  },
              )
            }
          />
        </TabsContent>
      ))}
    </Tabs>
  );
}

function ProjectWorkspace({
  project,
  paneControls,
  active,
  threads,
  onProjectSave,
  onThreadSave,
  onThreadDelete,
}: {
  project: Project;
  paneControls: HTMLDivElement | null;
  active: boolean;
  threads: Thread[];
  onProjectSave: (project: Project) => void;
  onThreadSave: (thread: Thread) => void;
  onThreadDelete: (id: string) => void;
}) {
  const [selected, setSelected] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Thread>();
  const store = useThreadStore();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const thread = threads.find((item) => item.id === selected) ?? threads[0];
  const layout = useDefaultLayout({
    id: `agentflare-panes-${project.id}`,
  });
  const groupRef = useGroupRef();
  const expandedSizes = useRef<Record<string, number>>({});
  const [hiddenPanes, setHiddenPanes] = useState<string[]>([]);
  const panes = [
    { id: "threads", label: "threads", icon: ListTree, min: 160 },
    { id: "terminal", label: "agent", icon: Bot, min: 300 },
    { id: "viewer", label: "file / diff", icon: FileDiff, min: 300 },
    { id: "navigation", label: "files / git", icon: FolderGit2, min: 230 },
  ];

  function togglePane(id: string) {
    if (!groupRef.current) return;
    const sizes = { ...groupRef.current.getLayout() };
    const key = `${project.id}-${id}`;
    const others = Object.keys(sizes).filter((k) => k !== key && sizes[k] > 0);
    if (!others.length) return;
    const previous = sizes[key];
    if (previous > 0) expandedSizes.current[key] = previous;
    const next =
      previous > 0 ? 0 : Math.min(expandedSizes.current[key] ?? 25, 70);
    // Redistribute only among visible panes; Panel.collapse() may otherwise
    // reopen a collapsed neighbour to absorb the freed space.
    const remaining = others.reduce((sum, k) => sum + sizes[k], 0);
    for (const k of others) sizes[k] *= (100 - next) / remaining;
    sizes[key] = next;
    if (previous === 0) {
      const visible = panes.filter(
        (pane) => sizes[`${project.id}-${pane.id}`] > 0,
      );
      const minimum = visible.reduce((sum, pane) => sum + pane.min, 0);
      const width = Math.max(
        minimum,
        (document.getElementById(key)?.parentElement?.clientWidth ?? 0) - 15,
      );
      // Reserve every visible pane's minimum before distributing spare room.
      // Otherwise normalization can collapse a neighbour while restoring one.
      const spare = 100 * (1 - minimum / width);
      for (const pane of visible) {
        const paneKey = `${project.id}-${pane.id}`;
        sizes[paneKey] =
          (100 * pane.min) / width + (spare * sizes[paneKey]) / 100;
      }
    }
    groupRef.current?.setLayout(sizes);
  }

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

  async function deleteThread() {
    if (!deleteTarget || pending) return;
    setPending(true);
    setError("");
    try {
      await apiRequest(`/threads/${deleteTarget.id}`, "DELETE");
      store.forget(deleteTarget.id);
      onThreadDelete(deleteTarget.id);
      setDeleteTarget(undefined);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Deletion failed.");
    } finally {
      setPending(false);
    }
  }

  if (!active) return null;

  return (
    <div className="min-w-0 flex-1 overflow-x-auto">
      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open && !pending) {
            setDeleteTarget(undefined);
            setError("");
          }
        }}
      >
        <DialogContent showCloseButton={!pending}>
          <DialogTitle>Delete {deleteTarget?.name}?</DialogTitle>
          <DialogDescription>
            {deleteTarget?.runtime === "user"
              ? "This permanently deletes this thread's workspace and uncommitted files. Your shared Codex login and other threads are kept. Pushed GitHub branches are not deleted."
              : "This permanently deletes the thread and destroys its sandbox, including uncommitted files and saved agent logins. Pushed GitHub branches are not deleted."}
          </DialogDescription>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setDeleteTarget(undefined)}
            >
              cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={deleteThread}
            >
              {pending
                ? "deleting workspace…"
                : deleteTarget?.runtime === "user"
                  ? "delete thread and workspace"
                  : "delete thread and sandbox"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {paneControls &&
        createPortal(
          <div
            className="flex items-center gap-0.5 border-l pl-2"
            role="group"
            aria-label="Visible workspace panes"
          >
            {panes.map((pane) => {
              const hidden = hiddenPanes.includes(pane.id);
              return (
                <button
                  key={pane.id}
                  type="button"
                  aria-pressed={!hidden}
                  aria-controls={`${project.id}-${pane.id}`}
                  aria-label={`${hidden ? "Show" : "Hide"} ${pane.label} pane`}
                  title={`${hidden ? "Show" : "Hide"} ${pane.label} pane`}
                  disabled={!hidden && hiddenPanes.length === 3}
                  onClick={() => togglePane(pane.id)}
                  className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 hover:bg-muted hover:text-foreground aria-pressed:text-foreground disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-primary"
                >
                  <pane.icon className="size-4" aria-hidden="true" />
                </button>
              );
            })}
          </div>,
          paneControls,
        )}
      <Group
        groupRef={groupRef}
        orientation="horizontal"
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={layout.onLayoutChanged}
        onLayoutChange={(sizes) => {
          const next = ["threads", "terminal", "viewer", "navigation"].filter(
            (id) => sizes[`${project.id}-${id}`] === 0,
          );
          setHiddenPanes((old) => (old.join() === next.join() ? old : next));
        }}
        className="min-h-[480px]"
        style={{
          height: "calc(100dvh - 48px)",
          minWidth: panes.reduce(
            (sum, pane) => sum + (hiddenPanes.includes(pane.id) ? 0 : pane.min),
            12,
          ),
        }}
        aria-label="Workspace panes"
      >
        <Panel
          id={`${project.id}-threads`}
          defaultSize="14%"
          minSize="160px"
          collapsible
          collapsedSize={0}
          inert={hiddenPanes.includes("threads")}
        >
          <aside
            className="flex h-full min-w-0 flex-col"
            aria-label={`${project.name} threads`}
          >
            <div className="flex h-10 items-center justify-between border-b px-3">
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
                <div key={item.id} className="flex min-w-0 items-center">
                  <button
                    type="button"
                    aria-current={item.id === thread?.id ? "true" : undefined}
                    onClick={() => setSelected(item.id)}
                    className={`min-w-0 flex-1 rounded-md px-3 py-2 text-left text-xs outline-offset-2 focus-visible:outline-primary ${item.id === thread?.id ? "bg-[var(--terminal)] text-foreground" : "text-muted-foreground hover:bg-[var(--terminal)]"}`}
                  >
                    <span className="block truncate">{item.name}</span>
                    <span className="mt-1 block text-[10px] text-muted-foreground">
                      {item.agent === "codex" && item.runtime === "user" ? (
                        <ThreadActivity ids={[item.id]} />
                      ) : (
                        agents[item.agent].name
                      )}
                    </span>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={pending}
                    aria-label={`Delete thread ${item.name}`}
                    onClick={() => {
                      setError("");
                      setDeleteTarget(item);
                    }}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
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
          hiddenPanes={hiddenPanes}
          onShowViewer={() => {
            if (hiddenPanes.includes("viewer")) togglePane("viewer");
          }}
        >
          {thread ? (
            <ThreadControls
              key={`${thread.id}:${thread.version}`}
              thread={thread}
              onSave={onThreadSave}
            />
          ) : (
            <div className="h-10 border-b px-3 py-3 text-xs">
              agent conversation
            </div>
          )}
        </RuntimeWorkspace>
      </Group>
    </div>
  );
}

function ThreadControls({
  thread,
  onSave,
}: {
  thread: Thread;
  onSave: (thread: Thread) => void;
}) {
  const [name, setName] = useState(thread.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const dirty = name !== thread.name;
  async function save(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      onSave(
        await apiRequest<Thread>(`/threads/${thread.id}`, "PATCH", {
          name,
          agent: "codex",
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
    <div className="min-w-0 flex-1">
      <form
        onSubmit={save}
        className="flex min-h-10 flex-wrap items-center justify-between gap-2 px-3 py-1"
      >
        <div className="flex min-w-0 basis-full items-center gap-2 sm:flex-1 sm:basis-auto">
          <span className="shrink-0 text-muted-foreground" title="Conversation">
            <MessageSquare className="size-3.5" aria-hidden="true" />
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
