"use client";

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { useTheme } from "next-themes";
import { Panel, Separator } from "react-resizable-panels";
import { RefreshCw, Files, FileDiff, GitBranch } from "lucide-react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { File, PatchDiff } from "@pierre/diffs/react";
import { AcpConversation } from "./acp-conversation";
import { Button } from "./ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { PublishChanges } from "./publish-changes";
import { apiRequest } from "@/lib/api-client";
import type { BranchReview, GitChange } from "@/lib/runtime";
import { useThreadStore, useThreadState } from "./thread-state";
import type { RepositoryState } from "@/lib/thread-state";
import type { RepositoryFileLink } from "@/lib/repository-links";

type RepositoryInspectorHandle = {
  openFile: (file: RepositoryFileLink) => void;
};

type RepositoryView = NonNullable<RepositoryState["view"]>;

export function RuntimeWorkspace({
  threadId,
  projectId,
  hiddenPanes,
  onShowViewer,
  children,
}: {
  threadId?: string;
  projectId: string;
  hiddenPanes: string[];
  onShowViewer: () => void;
  children: ReactNode;
}) {
  const store = useThreadStore();
  const {
    runtime: state,
    snapshot,
    hydrated,
    error,
    pending,
  } = useThreadState(threadId ?? "");
  const [agentControls, setAgentControls] = useState<HTMLDivElement | null>(
    null,
  );
  const inspectorRef = useRef<RepositoryInspectorHandle>(null);
  const base = `/threads/${threadId}/runtime`;
  const conversationVisible = !hiddenPanes.includes("terminal");
  useEffect(() => {
    store.select(threadId, conversationVisible);
    if (threadId) void store.ensure(threadId);
    return () => {
      if (store.active === threadId) store.select(undefined);
    };
  }, [store, threadId, conversationVisible]);
  async function start() {
    if (threadId) await store.start(threadId);
  }
  return (
    <>
      <Panel
        id={`${projectId}-terminal`}
        defaultSize="36%"
        minSize="300px"
        collapsible
        collapsedSize={0}
        inert={hiddenPanes.includes("terminal")}
      >
        <main
          className="flex h-full min-w-0 flex-col overflow-auto"
          aria-label="Thread agent"
        >
          <div className="flex min-h-10 shrink-0 items-center border-b">
            {children}
            <div
              ref={setAgentControls}
              className="flex shrink-0 items-center pr-2"
            />
          </div>
          {error && !state?.started && (
            <p role="alert" className="border-b p-3 text-xs text-destructive">
              {error}
            </p>
          )}
          {threadId && (state?.started || snapshot?.saved) ? (
            <AcpConversation
              key={threadId}
              threadId={threadId}
              headerTarget={agentControls}
              onOpenFile={(file) => {
                inspectorRef.current?.openFile(file);
                onShowViewer();
              }}
            />
          ) : (
            <div className="flex-1 bg-[var(--terminal)] p-6 text-xs">
              <p>
                {!threadId
                  ? "Create a thread to start a Codex workspace."
                  : pending
                    ? "Starting sandbox and checking out repository…"
                    : !hydrated
                      ? "Checking workspace…"
                      : "Start this thread to open its Codex workspace."}
              </p>
              {threadId && (
                <p className="mt-3 max-w-lg leading-5 text-muted-foreground">
                  Sign in to Codex from the conversation after startup. With
                  workspace saving configured, files and sessions resume from
                  the last successful checkpoint. Check save status before
                  leaving. Use Changes to publish a reviewed snapshot to a draft
                  PR.
                </p>
              )}
              {threadId && (
                <Button
                  variant="outline"
                  className="mt-4 rounded-none text-xs"
                  disabled={
                    pending || (!hydrated && !error) || (!state && !error)
                  }
                  onClick={() =>
                    state ? void start() : void store.ensure(threadId)
                  }
                >
                  {pending
                    ? "starting…"
                    : !state && error
                      ? "retry status"
                      : "start sandbox"}
                </Button>
              )}
            </div>
          )}
        </main>
      </Panel>
      <Separator
        className="workspace-divider"
        aria-label="Resize agent conversation and file view"
      />
      <RepositoryInspector
        key={base}
        base={base}
        threadId={threadId ?? ""}
        projectId={projectId}
        hiddenPanes={hiddenPanes}
        started={Boolean(
          hydrated &&
            state?.started &&
            !snapshot?.saved &&
            snapshot?.status !== "connecting",
        )}
        ref={inspectorRef}
      />
    </>
  );
}

function RepositoryTree({
  files,
  open,
}: {
  files: string[];
  open: (path: string) => void;
}) {
  const { model } = useFileTree({ paths: files });
  useEffect(() => {
    model.resetPaths(files);
  }, [model, files]);
  return (
    <FileTree
      model={model}
      className="repository-tree block h-full"
      onClick={(event) => {
        // Shadow-root events are retargeted to the host. Activate on every click
        // (including native keyboard activation), not only selection changes.
        const row = event.nativeEvent
          .composedPath()
          .find(
            (node): node is HTMLElement =>
              node instanceof HTMLElement && node.dataset.type === "item",
          );
        const path = row?.dataset.itemPath;
        if (path && model.getItem(path)?.isDirectory() === false) open(path);
      }}
    />
  );
}

function RepositoryInspector({
  base,
  threadId,
  projectId,
  started,
  hiddenPanes,
  ref,
}: {
  base: string;
  threadId: string;
  projectId: string;
  started: boolean;
  hiddenPanes: string[];
  ref: Ref<RepositoryInspectorHandle>;
}) {
  const { resolvedTheme } = useTheme();
  const themeType = resolvedTheme === "dark" ? "dark" : "light";
  const store = useThreadStore();
  const cached = store.get(threadId).repository;
  const [files, setFiles] = useState<string[]>(cached?.files ?? []);
  const [changes, setChanges] = useState<GitChange[]>(cached?.changes ?? []);
  const [review, setReview] = useState<BranchReview | undefined>(
    cached?.review,
  );
  const [tab, setTab] = useState(cached?.tab ?? "files");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState<RepositoryView | undefined>(cached?.view);
  const selection = useRef((cached?.view as RepositoryView)?.navigationId ?? 0);
  const selected = useRef<{ path: string; staged?: boolean | "branch" }>(
    cached?.selected,
  );
  useEffect(() => {
    if (threadId)
      store.update(threadId, {
        repository: {
          files,
          changes,
          review,
          view,
          tab,
          selected: selected.current,
        },
      });
  }, [store, threadId, files, changes, review, view, tab]);
  useEffect(() => {
    if (!started) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let loading = false;
    async function refresh() {
      if (loading || cancelled || document.hidden) return;
      loading = true;
      try {
        const [tree, git, branch] = await Promise.all([
          apiRequest<{ files: string[] }>(`${base}/files`),
          apiRequest<{ changes: GitChange[] }>(`${base}/git`),
          apiRequest<BranchReview>(`${base}/review`),
        ]);
        if (cancelled) return;
        setFiles((old) =>
          JSON.stringify(old) === JSON.stringify(tree.files) ? old : tree.files,
        );
        setChanges(git.changes);
        setReview(branch);
        setError("");
        const current = selected.current;
        const request = selection.current;
        if (current) {
          const result = await apiRequest<{ content?: string; patch?: string }>(
            viewUrl(base, current.path, current.staged),
          );
          if (!cancelled && request === selection.current)
            setView((old) =>
              old &&
              (old.content !== result.content || old.patch !== result.patch)
                ? { ...old, ...result }
                : old,
            );
        }
      } catch (error) {
        if (!cancelled)
          setError(error instanceof Error ? error.message : "Refresh failed.");
      } finally {
        loading = false;
        if (!cancelled) {
          clearTimeout(timer);
          timer = setTimeout(refresh, 5000);
        }
      }
    }
    const visible = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        void refresh();
      }
    };
    document.addEventListener("visibilitychange", visible);
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [base, revision, started]);
  const open = useCallback(
    async (
      path: string,
      staged?: boolean | "branch",
      lines?: RepositoryFileLink,
    ) => {
      const request = ++selection.current;
      selected.current = { path, staged };
      setView(undefined);
      setPending(true);
      setError("");
      try {
        const result = await apiRequest<{ content?: string; patch?: string }>(
          viewUrl(base, path, staged),
        );
        if (request === selection.current)
          setView({
            ...lines,
            path,
            ...result,
            navigationId: request,
            label:
              staged === "branch"
                ? "branch diff"
                : staged === undefined
                  ? "file"
                  : staged
                    ? "staged diff"
                    : "unstaged diff",
          });
      } catch (error) {
        if (request === selection.current)
          setError(error instanceof Error ? error.message : "Read failed.");
      } finally {
        if (request === selection.current) setPending(false);
      }
    },
    [base],
  );
  useImperativeHandle(
    ref,
    () => ({ openFile: (file) => void open(file.path, undefined, file) }),
    [open],
  );
  return (
    <>
      <Panel
        id={`${projectId}-viewer`}
        defaultSize="32%"
        minSize="300px"
        collapsible
        collapsedSize={0}
        inert={hiddenPanes.includes("viewer")}
      >
        <section
          className="flex h-full min-w-0 flex-col"
          aria-label="File and diff view"
        >
          <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b px-3 text-xs">
            <span className="truncate" title={view?.path}>
              {view ? `${view.path} / ${view.label}` : "file / diff"}
            </span>
            {view && (
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                aria-label="Close file view"
                onClick={() => {
                  selection.current++;
                  selected.current = undefined;
                  setView(undefined);
                }}
              >
                close
              </button>
            )}
          </div>
          {error && (
            <p role="alert" className="p-3 text-xs text-destructive">
              {error}
            </p>
          )}
          {pending && (
            <p role="status" className="p-3 text-xs">
              loading…
            </p>
          )}
          {view ? (
            <div className="min-h-0 flex-1 overflow-auto">
              {view.content !== undefined ? (
                <RepositoryFileView
                  key={view.navigationId}
                  view={view}
                  content={view.content}
                  themeType={themeType}
                />
              ) : view.patch ? (
                <PatchDiff
                  patch={view.patch}
                  options={{ diffStyle: "unified", themeType }}
                />
              ) : (
                <p className="p-4 text-xs">No text diff available.</p>
              )}
            </div>
          ) : (
            !pending && (
              <p className="p-4 text-xs text-muted-foreground">
                Select a file or Git change to review it here.
              </p>
            )
          )}
        </section>
      </Panel>
      <Separator
        className="workspace-divider"
        aria-label="Resize file view and repository navigation"
      />
      <Panel
        id={`${projectId}-navigation`}
        defaultSize="18%"
        minSize="230px"
        collapsible
        collapsedSize={0}
        inert={hiddenPanes.includes("navigation")}
      >
        <aside
          className="flex h-full min-w-0 flex-col"
          aria-label="Thread files and Git stage"
        >
          <Tabs
            value={tab}
            onValueChange={(value) => setTab(String(value))}
            className="min-h-0 flex-1 gap-0"
          >
            <div className="flex h-10 shrink-0 items-center justify-between border-b px-1">
              <TabsList
                variant="line"
                aria-label="Thread inspector"
                className="repository-tabs min-w-0"
              >
                <TabsTrigger value="files" aria-label="Files" title="Files">
                  <Files className="size-3.5" aria-hidden="true" />
                </TabsTrigger>
                <TabsTrigger
                  value="changes"
                  aria-label="Changes"
                  title="Changes"
                >
                  <FileDiff className="size-3.5" aria-hidden="true" />
                </TabsTrigger>
                <TabsTrigger value="git" aria-label="Git" title="Git">
                  <GitBranch className="size-3.5" aria-hidden="true" />
                </TabsTrigger>
              </TabsList>
              <button
                type="button"
                className="mx-2 shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
                aria-label="Refresh files and changes"
                title="Refresh files and changes"
                disabled={!started}
                onClick={() => setRevision((v) => v + 1)}
              >
                <RefreshCw className="size-3.5" />
              </button>
            </div>
            <TabsContent value="files" className="min-h-0 overflow-auto">
              {started ? (
                <RepositoryTree
                  files={files}
                  open={(path) => void open(path)}
                />
              ) : (
                <p className="p-4 text-xs text-muted-foreground">
                  Start a sandbox to browse files.
                </p>
              )}
            </TabsContent>
            <TabsContent value="changes" className="overflow-auto p-3 text-xs">
              {review ? (
                <>
                  <p className="mb-2 break-words text-muted-foreground">
                    {review.branch} → {review.baseBranch}
                  </p>
                  <p className="mb-3 text-[11px] text-muted-foreground">
                    All changes since branching, including local commits.
                    Updates automatically.
                  </p>
                  <PublishChanges
                    base={base}
                    review={review}
                    onPublished={() => setRevision((v) => v + 1)}
                  />
                  {review.changes.length === 0 && (
                    <p className="mt-3">No branch changes.</p>
                  )}
                  {review.changes.map((change) => (
                    <button
                      type="button"
                      key={change.path}
                      className="block w-full truncate py-1 text-left hover:text-primary"
                      onClick={() => void open(change.path, "branch")}
                    >
                      {change.status} {change.path}
                    </button>
                  ))}
                </>
              ) : (
                <p>
                  {started
                    ? "Loading branch changes…"
                    : "Start a sandbox to review changes."}
                </p>
              )}
            </TabsContent>
            <TabsContent value="git" className="overflow-auto p-3 text-xs">
              <p className="mb-3 text-[11px] text-muted-foreground">
                Local staging and commits are managed by the agent. Updates
                automatically.
              </p>
              {changes.length === 0 && (
                <p>
                  {started ? "No changes." : "Start a sandbox to inspect Git."}
                </p>
              )}
              {[true, false].map((staged) => (
                <div key={String(staged)} className="mb-4">
                  <h3 className="mb-2 text-muted-foreground">
                    {staged ? "staged" : "unstaged / untracked"}
                  </h3>
                  {changes
                    .filter((change) =>
                      staged
                        ? ![" ", "?"].includes(change.index)
                        : change.worktree !== " ",
                    )
                    .map((change) => (
                      <button
                        type="button"
                        key={change.path}
                        className="block w-full truncate py-1 text-left hover:text-primary"
                        onClick={() =>
                          void open(
                            change.path,
                            change.index === "?" ? undefined : staged,
                          )
                        }
                      >
                        {staged ? change.index : change.worktree} {change.path}
                      </button>
                    ))}
                </div>
              ))}
            </TabsContent>
          </Tabs>
        </aside>
      </Panel>
    </>
  );
}

function viewUrl(base: string, path: string, staged?: boolean | "branch") {
  return `${base}/${staged === "branch" ? "branch-diff" : staged === undefined ? "file" : "diff"}?path=${encodeURIComponent(path)}&staged=${staged === true}`;
}

function RepositoryFileView({
  view,
  content,
  themeType,
}: {
  view: RepositoryFileLink;
  content: string;
  themeType: "light" | "dark";
}) {
  const scrolled = useRef(false);
  return (
    <File
      file={{ name: view.path, contents: content }}
      selectedLines={
        view.startLine
          ? { start: view.startLine, end: view.endLine ?? view.startLine }
          : undefined
      }
      options={{
        themeType,
        onPostRender: (node, _instance, phase) => {
          if (phase === "unmount" || scrolled.current || !view.startLine)
            return;
          const line = node.shadowRoot?.querySelector<HTMLElement>(
            `[data-line="${view.startLine}"]`,
          );
          if (!line) return;
          line.scrollIntoView({ block: "center", inline: "nearest" });
          scrolled.current = true;
        },
      }}
    />
  );
}
