"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTheme } from "next-themes";
import { Panel, Separator } from "react-resizable-panels";
import { RefreshCw, Files, FileDiff, GitBranch } from "lucide-react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { File, PatchDiff } from "@pierre/diffs/react";
import { AcpConversation } from "./acp-conversation";
import { TerminalPreview } from "./terminal-preview";
import { Button } from "./ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { PublishChanges } from "./publish-changes";
import { apiRequest } from "@/lib/api-client";
import type { BranchReview, GitChange, RuntimeState } from "@/lib/runtime";

export function RuntimeWorkspace({
  threadId,
  projectId,
  hiddenPanes,
  children,
}: {
  threadId?: string;
  projectId: string;
  hiddenPanes: string[];
  children: (started: boolean) => ReactNode;
}) {
  const [state, setState] = useState<RuntimeState>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [agentControls, setAgentControls] = useState<HTMLDivElement | null>(
    null,
  );
  const base = `/threads/${threadId}/runtime`;
  useEffect(() => {
    if (!threadId) return;
    let cancelled = false;
    apiRequest<RuntimeState>(`${base}/status`)
      .then((value) => {
        if (!cancelled) setState(value);
      })
      .catch((error: Error) => {
        if (!cancelled) setError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [base, threadId]);
  async function start() {
    setPending(true);
    setError("");
    try {
      setState(await apiRequest<RuntimeState>(`${base}/start`, "POST", {}));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Start failed.");
    } finally {
      setPending(false);
    }
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
            {children(Boolean(state?.started))}
            <div
              ref={setAgentControls}
              className="flex shrink-0 items-center pr-2"
            />
          </div>
          {error && (
            <p role="alert" className="border-b p-3 text-xs text-destructive">
              {error}
            </p>
          )}
          {state?.started && threadId ? (
            state.agent === "codex" ? (
              <AcpConversation
                key={threadId}
                threadId={threadId}
                headerTarget={agentControls}
              />
            ) : (
              <TerminalPreview threadId={threadId} />
            )
          ) : (
            <div className="flex-1 bg-[var(--terminal)] p-6 text-xs">
              <p>
                {!threadId
                  ? "Create a thread to start a Codex workspace."
                  : pending
                    ? "Starting sandbox and checking out repository…"
                    : "Start this thread to open its Codex workspace."}
              </p>
              {threadId && (
                <p className="mt-3 max-w-lg leading-5 text-muted-foreground">
                  Sign in to Codex from the conversation after startup. Sandbox
                  files are temporary and may be lost after 30 minutes idle or a
                  container restart. Export important work before leaving;
                  thread metadata is not a backup. Use Changes to publish a
                  reviewed snapshot to a draft PR.
                </p>
              )}
              {threadId && (
                <Button
                  variant="outline"
                  className="mt-4 rounded-none text-xs"
                  disabled={pending || !state}
                  onClick={start}
                >
                  {pending ? "starting…" : "start sandbox"}
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
        projectId={projectId}
        hiddenPanes={hiddenPanes}
        started={Boolean(state?.started)}
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
  projectId,
  started,
  hiddenPanes,
}: {
  base: string;
  projectId: string;
  started: boolean;
  hiddenPanes: string[];
}) {
  const { resolvedTheme } = useTheme();
  const themeType = resolvedTheme === "dark" ? "dark" : "light";
  const [files, setFiles] = useState<string[]>([]);
  const [changes, setChanges] = useState<GitChange[]>([]);
  const [review, setReview] = useState<BranchReview>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState<{
    path: string;
    content?: string;
    patch?: string;
    label: string;
  }>();
  const selection = useRef(0);
  const selected = useRef<{ path: string; staged?: boolean | "branch" }>(
    undefined,
  );
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
  async function open(path: string, staged?: boolean | "branch") {
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
          path,
          ...result,
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
  }
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
                <File
                  file={{ name: view.path, contents: view.content }}
                  options={{ themeType }}
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
          <Tabs defaultValue="files" className="min-h-0 flex-1 gap-0">
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
