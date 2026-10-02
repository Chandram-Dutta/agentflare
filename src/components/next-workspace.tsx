"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useTransition,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import NextLink, { useLinkStatus } from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Group, Panel, Separator } from "react-resizable-panels";
import {
  ArrowUpRight,
  ChevronRight,
  GitBranch,
  LogOut,
  MessageSquare,
  Moon,
  PanelLeft,
  Plus,
  Sun,
  Trash2,
  Info,
} from "lucide-react";
import { Button } from "./ui/button";
import { toast } from "./ui/toast";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { ProjectSettings } from "./project-settings";
import {
  ThreadStateProvider,
  ThreadActivity,
  useThreadState,
  useThreadStore,
} from "./thread-state";
import { AcpConversation } from "./acp-conversation";
import { RepositoryInspector } from "./runtime-workspace";
import { apiRequest } from "@/lib/api-client";
import {
  changeViews,
  parseWorkspaceRoute,
  workspaceHref,
  type ChangeView,
} from "@/lib/workspace-route";
import type { Project, Thread, WorkspaceData } from "@/lib/workspace";
import type { Viewer } from "@/server/auth";
import type { RepositoryFileLink } from "@/lib/repository-links";
import {
  createRepositoryContext,
  appendRepositoryContext,
} from "@/lib/repository-context";
import { BranchDiffReview } from "./branch-diff-review";
import { WorkspaceNavigation } from "./workspace-navigation";
import { WorkspacePersistence } from "@/lib/workspace-persistence";
import { ThreadAttentionInbox, ThreadNotifications } from "./thread-attention";
import { NotificationSettings } from "./notification-settings";

type ReviewContext = Parameters<typeof createRepositoryContext>[0];

const ReviewContent = createContext<ReactNode>(null);

function LinkProgress() {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden="true"
      className={`ml-1 inline-block size-1.5 shrink-0 rounded-full bg-current transition-opacity ${pending ? "animate-pulse opacity-60" : "opacity-0"}`}
    />
  );
}

function Link({ children, ...props }: React.ComponentProps<typeof NextLink>) {
  return (
    <NextLink {...props}>
      {children}
      <LinkProgress />
    </NextLink>
  );
}

// The route page renders this outlet only after its server-side ownership check.
// The persistent layout keeps the workspace cache and drafts across routes.
export function WorkspaceContent() {
  return useContext(ReviewContent);
}

function subscribeNarrow(callback: () => void) {
  const media = window.matchMedia("(max-width: 900px)");
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}

export function NextWorkspace({
  user,
  children,
}: {
  user: Viewer;
  children: ReactNode;
}) {
  return (
    <ThreadStateProvider key={user.id}>
      <WorkspaceShell user={user}>{children}</WorkspaceShell>
    </ThreadStateProvider>
  );
}

function WorkspaceShell({
  user,
  children,
}: {
  user: Viewer;
  children: ReactNode;
}) {
  const router = useRouter();
  const [navigating, startNavigation] = useTransition();
  const pathname = usePathname();
  const route = parseWorkspaceRoute(pathname);
  const store = useThreadStore();
  const { resolvedTheme, setTheme } = useTheme();
  const [data, setData] = useState<WorkspaceData>();
  const [error, setError] = useState("");
  const [operation, setOperation] = useState<
    "creating" | "deleting" | "signing-out"
  >();
  const [panes, setPanes] = useState<{
    id?: string;
    sidebar: boolean;
    agent: boolean;
  }>({ sidebar: true, agent: true });
  const [deleting, setDeleting] = useState<Thread>();
  const [recoveryInfo, setRecoveryInfo] = useState(false);
  const [reviewToOpen, setReviewToOpen] = useState<string>();
  const [fileToOpen, setFileToOpen] = useState<{
    threadId: string;
    file: RepositoryFileLink;
  }>();
  const narrow = useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia("(max-width: 900px)").matches,
    () => false,
  );
  const [mobilePane, setMobilePane] = useState<"changes" | "review" | "agent">(
    "review",
  );
  const project = data?.projects.find((item) => item.id === route?.projectId);
  const change = data?.threads.find(
    (item) => item.id === route?.changeId && item.projectId === project?.id,
  );
  const changes =
    data?.threads.filter((item) => item.projectId === project?.id) ?? [];
  const openAttention = useCallback(
    (thread: Thread) => {
      router.push(workspaceHref(thread.projectId, thread.id));
      setMobilePane("agent");
    },
    [router],
  );
  const [persistence, setPersistence] = useState<WorkspacePersistence>();
  const [storageWarning, setStorageWarning] = useState("");
  const savedPanes = change ? persistence?.read(change.id) : undefined;
  const sidebar =
    panes.id === change?.id ? panes.sidebar : (savedPanes?.sidebar ?? true);
  const agent =
    panes.id === change?.id ? panes.agent : (savedPanes?.agent ?? true);
  const showSidebar = narrow ? mobilePane === "changes" : sidebar;
  const showAgent = narrow ? mobilePane === "agent" : agent;
  function setSidebar(value: boolean) {
    setPanes({ id: change?.id, sidebar: value, agent });
    if (change) persistence?.patch(change.id, { sidebar: value });
  }
  function setAgent(value: boolean) {
    setPanes({ id: change?.id, sidebar, agent: value });
    if (change) persistence?.patch(change.id, { agent: value });
  }
  useEffect(() => {
    if (!data) return;
    return persistence?.connect(
      store,
      data.threads.map((thread) => thread.id),
    );
  }, [persistence, data, store]);

  function openFile(file: RepositoryFileLink) {
    if (!change) return;
    setFileToOpen({ threadId: change.id, file });
    setMobilePane("review");
    const query = new URLSearchParams({ file: file.path });
    if (file.startLine) query.set("line", String(file.startLine));
    startNavigation(() =>
      router.push(
        `${workspaceHref(change.projectId, change.id, "code")}?${query}`,
      ),
    );
  }
  useEffect(() => {
    const restore = () => {
      const params = new URLSearchParams(window.location.search);
      const path = params.get("file");
      if (change && path) {
        const line = Number(params.get("line"));
        setFileToOpen({
          threadId: change.id,
          file: { path, startLine: line > 0 ? line : undefined },
        });
        setMobilePane("review");
      }
    };
    restore();
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [change, pathname]);

  useEffect(() => {
    store.select(change?.id, !document.hidden);
    if (change) void store.ensure(change.id);
    return () => store.select(undefined);
  }, [store, change]);

  useEffect(() => {
    const controller = new AbortController();
    let saved: WorkspacePersistence | undefined;
    const changed = (event: StorageEvent) => {
      if (event.key === "agentflare:account" && event.newValue !== user.id) {
        saved?.clear();
        window.location.reload();
      }
    };
    void apiRequest<WorkspaceData>(
      "/workspace",
      "GET",
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        try {
          saved = new WorkspacePersistence(
            localStorage,
            sessionStorage,
            user.id,
            setStorageWarning,
          );
          localStorage.setItem("agentflare:account", user.id);
          // Hydrate the existing store before any repository/composer view mounts.
          saved.connect(
            store,
            result.threads.map((thread) => thread.id),
          )();
          setPersistence(saved);
        } catch {
          setStorageWarning(
            "Browser storage is unavailable. Drafts and layout will not survive reload.",
          );
        }
        setData(result);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    window.addEventListener("storage", changed);
    return () => {
      controller.abort();
      window.removeEventListener("storage", changed);
    };
  }, [store, user.id]);

  useEffect(() => {
    const title =
      operation === "creating"
        ? "Creating and starting thread…"
        : operation === "deleting"
          ? "Deleting thread…"
          : operation === "signing-out"
            ? "Signing out…"
            : navigating
              ? "Opening workspace…"
              : undefined;
    if (!title) return;
    let id: string | undefined;
    const timer = setTimeout(() => {
      id = toast.add({ title, type: "loading", timeout: 0 });
    }, 300);
    return () => {
      clearTimeout(timer);
      if (id) toast.close(id);
    };
  }, [operation, navigating]);

  function saveProject(saved: Project) {
    setData(
      (current) =>
        current && {
          ...current,
          projects: [
            ...current.projects.filter((p) => p.id !== saved.id),
            saved,
          ],
        },
    );
    startNavigation(() => router.push(workspaceHref(saved.id)));
  }
  async function createChange() {
    if (!project || operation) return;
    setOperation("creating");
    setError("");
    try {
      const saved = await apiRequest<Thread>(
        `/projects/${project.id}/threads`,
        "POST",
        { name: `Thread ${crypto.randomUUID().slice(0, 8)}`, agent: "codex" },
      );
      setData(
        (current) =>
          current && { ...current, threads: [...current.threads, saved] },
      );
      setAgent(true);
      setMobilePane("agent");
      startNavigation(() => router.push(workspaceHref(project.id, saved.id)));
      await store.ensure(saved.id);
      await store.start(saved.id);
    } catch (cause) {
      toast.add({
        title: "Could not start thread",
        description: cause instanceof Error ? cause.message : "Try again.",
        type: "error",
        timeout: 10000,
      });
    } finally {
      setOperation(undefined);
    }
  }
  async function deleteChange() {
    if (!deleting || operation) return;
    setOperation("deleting");
    setError("");
    try {
      await apiRequest(`/threads/${deleting.id}`, "DELETE");
      store.forget(deleting.id);
      persistence?.forget(deleting.id);
      setData(
        (current) =>
          current && {
            ...current,
            threads: current.threads.filter((t) => t.id !== deleting.id),
          },
      );
      if (change?.id === deleting.id)
        router.replace(workspaceHref(deleting.projectId));
      toast.add({ title: "Thread deleted", description: deleting.name });
      setDeleting(undefined);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not delete thread.",
      );
    } finally {
      setOperation(undefined);
    }
  }
  async function signOut() {
    if (operation) return;
    setOperation("signing-out");
    setError("");
    try {
      await apiRequest("/auth/sign-out", "POST", {});
      persistence?.clear();
      try {
        localStorage.removeItem("agentflare:account");
      } catch {
        /* Storage may be disabled. */
      }
      window.location.reload();
    } catch (cause) {
      toast.add({
        title: "Sign-out failed",
        description: cause instanceof Error ? cause.message : "Try again.",
        type: "error",
        timeout: 10000,
      });
      setOperation(undefined);
    }
  }

  return (
    <div className="workspace-shell work-tabs flex h-dvh min-h-0 flex-col overflow-hidden">
      {data && (
        <ThreadNotifications
          projects={data.projects}
          threads={data.threads}
          onSelect={openAttention}
        />
      )}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3 text-xs">
        <Link href="/workspace" className="shrink-0 font-medium">
          agentflare<span className="text-primary">_</span>
          <span className="ml-2 hidden text-[10px] text-muted-foreground sm:inline">
            next
          </span>
        </Link>
        <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        <select
          aria-label="Project"
          className="min-w-0 max-w-44 bg-transparent py-1"
          value={project?.id ?? ""}
          onChange={(event) =>
            startNavigation(() =>
              router.push(workspaceHref(event.target.value || undefined)),
            )
          }
        >
          <option value="">Projects</option>
          {data?.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <ProjectSettings onSave={saveProject} />
        {change && (
          <span className="hidden min-w-0 truncate text-muted-foreground md:inline">
            / {change.name}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <WorkspaceNavigation
            key={change?.id ?? "projects"}
            data={data}
            thread={change}
            navigate={(href) => {
              setMobilePane("review");
              startNavigation(() => router.push(href));
            }}
            openFile={openFile}
            showConversation={() => {
              setAgent(true);
              setMobilePane("agent");
            }}
            newThread={() => void createChange()}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Toggle threads pane"
            title="Toggle threads pane"
            aria-pressed={showSidebar}
            onClick={() =>
              narrow
                ? setMobilePane(showSidebar ? "review" : "changes")
                : setSidebar(!sidebar)
            }
          >
            <PanelLeft className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Toggle agent pane"
            title="Toggle agent pane"
            disabled={!change}
            aria-pressed={showAgent}
            onClick={() =>
              narrow
                ? setMobilePane(showAgent ? "review" : "agent")
                : setAgent(!agent)
            }
          >
            <MessageSquare className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Toggle theme"
            title="Toggle theme"
            onClick={() =>
              setTheme(resolvedTheme === "dark" ? "light" : "dark")
            }
          >
            <Moon className="size-4 dark:hidden" />
            <Sun className="hidden size-4 dark:block" />
          </Button>
          <NotificationSettings userId={user.id} />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Sign out ${user.name}`}
            title="Sign out"
            disabled={Boolean(operation)}
            onClick={signOut}
          >
            <LogOut className="size-4" />
          </Button>
        </div>
      </header>
      {storageWarning && (
        <p role="alert" className="border-b px-3 py-2 text-xs text-destructive">
          {storageWarning}
        </p>
      )}
      {error && !deleting && (
        <div
          role="alert"
          className="border-b px-4 py-2 text-xs text-destructive"
        >
          {error}
          <Button
            variant="link"
            className="ml-2 text-xs"
            onClick={() => setError("")}
          >
            Dismiss
          </Button>
        </div>
      )}
      {!data ? (
        <p role="status" className="p-6 text-xs">
          {error
            ? "Workspace unavailable. Reload to retry."
            : "Loading workspace…"}
        </p>
      ) : (
        <Group
          key={`${change?.id ?? "home"}-${narrow}-${showSidebar}-${showAgent}`}
          defaultLayout={
            !narrow && change ? persistence?.read(change.id).layout : undefined
          }
          onLayoutChanged={(layout) => {
            if (!narrow && change) persistence?.patch(change.id, { layout });
          }}
          orientation="horizontal"
          className="min-h-0 flex-1"
          aria-label="Review workspace"
        >
          {showSidebar && (
            <>
              <Panel id="changes" defaultSize="18%" minSize="150px">
                <aside
                  className="flex h-full flex-col overflow-auto"
                  aria-label="Threads"
                >
                  <div className="flex h-11 shrink-0 items-center justify-between border-b px-3 text-xs">
                    <span>{project ? "Threads" : "Projects"}</span>
                    {project && (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="New thread"
                        title="New thread"
                        disabled={Boolean(operation)}
                        onClick={() => void createChange()}
                      >
                        <Plus className="size-4" />
                      </Button>
                    )}
                  </div>
                  <ThreadAttentionInbox
                    projects={data.projects}
                    threads={data.threads}
                    onSelect={openAttention}
                  />
                  <nav
                    className="min-h-0 flex-1 space-y-1 overflow-auto p-2"
                    aria-label={project ? "Project threads" : "Projects"}
                  >
                    {!project &&
                      data.projects.map((p) => (
                        <Link
                          key={p.id}
                          href={workspaceHref(p.id)}
                          onClick={() => setMobilePane("review")}
                          className="block rounded-md px-3 py-3 text-xs hover:bg-muted"
                        >
                          {p.name}
                          <span className="mt-1 block truncate text-[10px] text-muted-foreground">
                            {p.repository.replace("https://github.com/", "")}
                          </span>
                        </Link>
                      ))}
                    {project &&
                      changes.map((item) => (
                        <div
                          key={item.id}
                          className={`group flex items-center rounded-md ${change?.id === item.id ? "bg-muted" : "hover:bg-muted"}`}
                        >
                          <Link
                            href={workspaceHref(
                              project.id,
                              item.id,
                              route?.view,
                            )}
                            aria-current={
                              change?.id === item.id ? "page" : undefined
                            }
                            onClick={() => setMobilePane("review")}
                            className="min-w-0 flex-1 px-3 py-3 text-xs"
                          >
                            <span className="block truncate">{item.name}</span>
                            <span className="mt-2 block text-[10px] text-muted-foreground">
                              <ThreadActivity ids={[item.id]} />
                            </span>
                          </Link>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            className="mr-1"
                            aria-label={`Delete ${item.name}`}
                            title="Delete thread"
                            onClick={() => {
                              setError("");
                              setDeleting(item);
                            }}
                          >
                            <Trash2 className="size-3" />
                          </Button>
                        </div>
                      ))}
                  </nav>
                  {project && (
                    <div className="flex items-center gap-2 border-t px-3 py-2">
                      <a
                        href={project.repository}
                        target="_blank"
                        rel="noreferrer"
                        className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground"
                      >
                        {project.repository.replace("https://github.com/", "")}
                      </a>
                      <ProjectSettings project={project} onSave={saveProject} />
                    </div>
                  )}
                </aside>
              </Panel>
              <Separator
                className="workspace-divider"
                aria-label="Resize threads list"
              />
            </>
          )}
          {(!narrow ||
            mobilePane === "review" ||
            (mobilePane === "agent" && !change)) && (
            <Panel
              id="review"
              defaultSize={agent && change ? "52%" : "82%"}
              minSize="240px"
            >
              <ReviewContent.Provider
                value={
                  !route ||
                  (route.projectId && !project) ||
                  (route.changeId && !change) ? (
                    <p className="p-6 text-xs">
                      This thread is no longer available. Choose another thread.
                    </p>
                  ) : change && project ? (
                    <ChangeReview
                      key={change.id}
                      change={change}
                      persistence={persistence}
                      openReview={reviewToOpen === change.id}
                      onReviewOpened={() => setReviewToOpen(undefined)}
                      project={project}
                      narrow={narrow}
                      view={route?.view ?? "overview"}
                      fileToOpen={
                        fileToOpen?.threadId === change.id
                          ? fileToOpen.file
                          : undefined
                      }
                      onFileOpened={() => setFileToOpen(undefined)}
                      onAddContext={(context) => {
                        const current = store.get(change.id);
                        if (
                          current.pending ||
                          (!current.runtime?.autoResume &&
                            (current.snapshot?.saved ||
                              (current.snapshot?.workspace &&
                                current.snapshot.workspace !== "running"))) ||
                          current.snapshot?.status !== "ready"
                        ) {
                          throw new Error(
                            "Connect the agent and wait for it to be ready before adding context.",
                          );
                        }
                        const attachments = appendRepositoryContext(
                          current.attachments,
                          createRepositoryContext(context),
                          current.snapshot?.promptCapabilities,
                          current.draft,
                        );
                        store.update(change.id, { attachments });
                        setAgent(true);
                        setMobilePane("agent");
                      }}
                    />
                  ) : (
                    <section className="mx-auto max-w-2xl p-6 sm:p-10">
                      <p className="text-xs text-muted-foreground">
                        {project
                          ? project.repository.replace(
                              "https://github.com/",
                              "",
                            )
                          : "Agentflare Next / development preview"}
                      </p>
                      <h1 className="mt-4 text-2xl">
                        {project ? project.name : "Projects"}
                      </h1>
                      {(route?.changeId || (route?.projectId && !project)) && (
                        <p className="mt-4 text-sm text-muted-foreground">
                          This destination is not available.
                        </p>
                      )}
                      <div className="mt-6">
                        {project ? (
                          <Button
                            disabled={Boolean(operation)}
                            onClick={() => void createChange()}
                          >
                            <Plus className="size-4" /> New thread
                          </Button>
                        ) : (
                          <div className="flex items-center gap-2 text-xs">
                            <ProjectSettings onSave={saveProject} /> Add your
                            first project
                          </div>
                        )}
                      </div>
                    </section>
                  )
                }
              >
                {children}
              </ReviewContent.Provider>
            </Panel>
          )}
          {showAgent && change && (
            <>
              <Separator
                className="workspace-divider"
                aria-label="Resize agent conversation"
              />
              <Panel id="agent" defaultSize="30%" minSize="260px">
                <DeveloperPane
                  key={change.id}
                  change={change}
                  onOpenFile={openFile}
                  onReviewChanges={() => {
                    setFileToOpen(undefined);
                    setReviewToOpen(change.id);
                    setMobilePane("review");
                    startNavigation(() =>
                      router.push(
                        workspaceHref(change.projectId, change.id, "code"),
                      ),
                    );
                  }}
                />
              </Panel>
            </>
          )}
        </Group>
      )}
      <footer className="flex h-7 shrink-0 items-center gap-3 border-t px-3 text-[10px] text-muted-foreground">
        <GitBranch className="size-3" />
        <span className="truncate">{change ? change.name : project?.name}</span>
        <button
          className="ml-auto shrink-0 underline-offset-2 hover:underline"
          aria-label="Browser recovery details"
          title="Browser recovery details"
          onClick={() => setRecoveryInfo(true)}
        >
          <Info className="size-3.5" aria-hidden="true" />
        </button>
      </footer>
      <Dialog open={recoveryInfo} onOpenChange={setRecoveryInfo}>
        <DialogContent>
          <DialogTitle>Browser recovery</DialogTitle>
          <DialogDescription>
            Drafts and attachments are stored unencrypted in this tab’s session
            storage for reload recovery, for up to seven days. Same-origin
            scripts can read them, and browser session restoration may retain
            them after closing a tab. Signing out or changing accounts clears
            recovery data. Storage failures appear above the workspace.
          </DialogDescription>
          <p className="text-xs text-muted-foreground">
            Pane sizes, file paths, positions and review fingerprints are saved
            for this account on this installation. Source files and
            conversations are not copied into durable browser storage.
          </p>
          <Button
            variant="outline"
            onClick={() => {
              persistence?.clear();
              setStorageWarning(
                "Browser recovery cleared and disabled until reload. Current drafts remain in memory.",
              );
              setRecoveryInfo(false);
            }}
          >
            Clear browser recovery
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(deleting)}
        onOpenChange={(value) => {
          if (!value && operation !== "deleting") setDeleting(undefined);
        }}
      >
        <DialogContent>
          <DialogTitle>Delete {deleting?.name}?</DialogTitle>
          <DialogDescription>
            This removes its checkout and saved conversation, including unpushed
            work. Published GitHub branches and other threads are kept.
          </DialogDescription>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={operation === "deleting"}
              onClick={() => setDeleting(undefined)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={operation === "deleting"}
              onClick={deleteChange}
            >
              {operation === "deleting" ? "Deleting…" : "Delete thread"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ChangeReview({
  change,
  project,
  view,
  narrow,
  fileToOpen,
  onFileOpened,
  onAddContext,
  persistence,
  openReview,
  onReviewOpened,
}: {
  change: Thread;
  project: Project;
  view: ChangeView;
  narrow: boolean;
  fileToOpen?: RepositoryFileLink;
  onFileOpened: () => void;
  onAddContext: (context: ReviewContext) => void;
  persistence?: WorkspacePersistence;
  openReview: boolean;
  onReviewOpened: () => void;
}) {
  const state = useThreadState(change.id);
  const [progress, setProgress] = useState(
    () => persistence?.read(change.id).review ?? { reviewed: {} },
  );
  const review = state.repository?.review;
  const { resolvedTheme } = useTheme();
  const inspector = useRef<{
    openFile: (file: RepositoryFileLink) => void;
    openReview: () => void;
  }>(null);
  useEffect(() => {
    if (view === "code" && openReview && inspector.current) {
      inspector.current.openReview();
      onReviewOpened();
    }
  }, [view, openReview, onReviewOpened]);
  useEffect(() => {
    if (view === "code" && fileToOpen && inspector.current) {
      inspector.current.openFile(fileToOpen);
      onFileOpened();
    }
  }, [view, fileToOpen, onFileOpened]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <nav
        aria-label="Thread views"
        className="flex h-11 shrink-0 items-center gap-5 border-b px-4 text-xs"
      >
        {changeViews.map((item) => (
          <Link
            key={item}
            href={workspaceHref(project.id, change.id, item)}
            aria-current={view === item ? "page" : undefined}
            className={`flex h-full items-center border-b-2 capitalize ${view === item ? "border-primary text-foreground" : "border-transparent text-muted-foreground"}`}
          >
            {item}
          </Link>
        ))}
      </nav>
      {view === "code" ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <Group
            orientation={narrow ? "vertical" : "horizontal"}
            className={narrow ? "h-full" : "h-full min-w-[535px]"}
            aria-label="Code and files"
          >
            <RepositoryInspector
              key={change.id}
              ref={inspector}
              projectId={project.id}
              threadId={change.id}
              base={`/threads/${change.id}/runtime`}
              hiddenPanes={[]}
              navigationFirst
              stacked={narrow}
              initialTab="changes"
              onAddContext={onAddContext}
              onNavigateFile={(file) => {
                const params = new URLSearchParams({ file: file.path });
                if (file.startLine) params.set("line", String(file.startLine));
                const href = `${workspaceHref(project.id, change.id, "code")}?${params}`;
                if (window.location.pathname + window.location.search !== href)
                  window.history.pushState(window.history.state, "", href);
              }}
              renderBranchReview={(branch) => (
                <BranchDiffReview
                  {...{
                    state: progress,
                    initialScrollTop: persistence?.read(change.id)
                      .reviewScrollTop,
                    onScrollPositionChange: (reviewScrollTop: number) =>
                      persistence?.patch(change.id, { reviewScrollTop }),
                    onStateChange: (value: {
                      reviewed: Record<string, string>;
                    }) => {
                      setProgress(value);
                      persistence?.patch(change.id, { review: value });
                    },
                  }}
                  base={`/threads/${change.id}/runtime`}
                  review={branch}
                  themeType={resolvedTheme === "dark" ? "dark" : "light"}
                  onAddContext={onAddContext}
                />
              )}
              started={Boolean(
                state.hydrated &&
                  state.runtime?.started &&
                  (state.runtime.autoResume ||
                    (!state.snapshot?.saved &&
                      (!state.snapshot?.workspace ||
                        state.snapshot.workspace === "running"))) &&
                  state.snapshot?.status !== "connecting",
              )}
            />
          </Group>
        </div>
      ) : (
        <section className="min-h-0 flex-1 overflow-auto p-6 sm:p-8">
          <p className="text-xs text-muted-foreground">
            Thread / <ThreadActivity ids={[change.id]} />
          </p>
          <h1 className="mt-4 break-words text-xl">{change.name}</h1>
          <dl className="mt-8 space-y-4 text-xs">
            <div className="border-b pb-3">
              <dt className="text-muted-foreground">Repository</dt>
              <dd className="mt-1 break-all">
                {project.repository.replace("https://github.com/", "")}
              </dd>
            </div>
            <div className="border-b pb-3">
              <dt className="text-muted-foreground">Workspace</dt>
              <dd className="mt-1">
                {state.snapshot?.workspace
                  ? state.snapshot.workspace === "failed"
                    ? "Interrupted · recover from the conversation"
                    : state.snapshot.workspace
                  : state.snapshot?.saved
                    ? "Saved conversation · resume to inspect files"
                    : state.runtime?.started
                      ? "Running"
                      : state.pending
                        ? "Starting…"
                        : "Not running"}
              </dd>
            </div>
            {review && (
              <div className="border-b pb-3">
                <dt className="text-muted-foreground">Review evidence</dt>
                <dd className="mt-1">
                  {`${review.changes.length} changed paths · against ${review.baseBranch}`}
                </dd>
              </div>
            )}
          </dl>
          <Link
            href={workspaceHref(project.id, change.id, "code")}
            className="mt-6 inline-flex items-center gap-2 text-xs text-primary"
          >
            Review code <ChevronRight className="size-3" />
          </Link>
          {review?.published && (
            <a
              href={review.published.url}
              target="_blank"
              rel="noreferrer"
              className="ml-5 inline-flex items-center gap-2 text-xs"
            >
              Draft PR #{review.published.number}
              <ArrowUpRight className="size-3" />
            </a>
          )}
        </section>
      )}
    </div>
  );
}

function DeveloperPane({
  change,
  onOpenFile,
  onReviewChanges,
}: {
  change: Thread;
  onOpenFile: (file: RepositoryFileLink) => void;
  onReviewChanges: () => void;
}) {
  const store = useThreadStore();
  const state = useThreadState(change.id);
  const [controls, setControls] = useState<HTMLDivElement | null>(null);
  return (
    <section
      className="flex h-full min-h-0 flex-col"
      aria-label="Developer agent"
    >
      <header className="flex min-h-11 shrink-0 items-center justify-between gap-2 border-b px-3 text-xs">
        <span>Developer</span>
        <div ref={setControls} />
      </header>
      {state.runtime?.started || state.snapshot?.saved ? (
        <AcpConversation
          key={change.id}
          threadId={change.id}
          headerTarget={controls}
          onOpenFile={onOpenFile}
          onReviewChanges={onReviewChanges}
        />
      ) : (
        <div className="p-5 text-xs leading-5">
          {state.error && (
            <p role="alert" className="mt-3 text-destructive">
              {state.error}
            </p>
          )}
          <Button
            className="mt-5"
            variant="outline"
            disabled={state.pending || (!state.hydrated && !state.error)}
            onClick={() =>
              state.runtime
                ? void store.start(change.id)
                : void store.ensure(change.id)
            }
          >
            {state.pending
              ? "Starting…"
              : state.runtime
                ? "Start workspace"
                : "Retry connection"}
          </Button>
        </div>
      )}
    </section>
  );
}
