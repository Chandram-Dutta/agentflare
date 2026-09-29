"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTheme } from "next-themes";
import { Panel, Separator } from "react-resizable-panels";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { File, PatchDiff } from "@pierre/diffs/react";
import { TerminalPreview } from "./terminal-preview";
import { Button } from "./ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { apiRequest } from "@/lib/api-client";
import type { GitChange, RuntimeState } from "@/lib/runtime";

export function RuntimeWorkspace({
  threadId,
  projectId,
  children,
}: {
  threadId?: string;
  projectId: string;
  children: (started: boolean) => ReactNode;
}) {
  const [state, setState] = useState<RuntimeState>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
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
      <Panel id={`${projectId}-terminal`} defaultSize="36%" minSize="300px">
        <main
          className="flex h-full min-w-0 flex-col overflow-auto"
          aria-label="Thread terminal"
        >
          {children(Boolean(state?.started))}
          {error && (
            <p role="alert" className="border-b p-3 text-xs text-destructive">
              {error}
            </p>
          )}
          {state?.started && threadId ? (
            <TerminalPreview threadId={threadId} />
          ) : (
            <div className="flex-1 bg-[var(--terminal)] p-6 text-xs">
              <p>
                {!threadId
                  ? "Create a thread to choose a CLI agent."
                  : pending
                    ? "Starting sandbox and checking out repository…"
                    : "Start this thread to open its CLI agent."}
              </p>
              {threadId && (
                <p className="mt-3 max-w-lg leading-5 text-muted-foreground">
                  Sign in to the agent inside its terminal. Sandbox files are
                  temporary and may be lost after 30 minutes idle or a container
                  restart. Export important work before leaving; thread metadata
                  is not a backup. Git push credentials are not connected yet.
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
        aria-label="Resize agent CLI and file view"
      />
      <RepositoryInspector
        base={base}
        projectId={projectId}
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
      className="block h-full"
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
}: {
  base: string;
  projectId: string;
  started: boolean;
}) {
  const { resolvedTheme } = useTheme();
  const themeType = resolvedTheme === "dark" ? "dark" : "light";
  const [files, setFiles] = useState<string[]>([]);
  const [changes, setChanges] = useState<GitChange[]>([]);
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
  useEffect(() => {
    if (!started) return;
    let cancelled = false;
    Promise.all([
      apiRequest<{ files: string[] }>(`${base}/files`),
      apiRequest<{ changes: GitChange[] }>(`${base}/git`),
    ])
      .then(([tree, git]) => {
        if (!cancelled) {
          setFiles(tree.files);
          setChanges(git.changes);
          setError("");
        }
      })
      .catch((error: Error) => {
        if (!cancelled) setError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [base, revision, started]);
  async function open(path: string, staged?: boolean) {
    const request = ++selection.current;
    setView(undefined);
    setPending(true);
    setError("");
    try {
      const result = await apiRequest<{ content?: string; patch?: string }>(
        `${base}/${staged === undefined ? "file" : "diff"}?path=${encodeURIComponent(path)}&staged=${staged === true}`,
      );
      if (request === selection.current)
        setView({
          path,
          ...result,
          label:
            staged === undefined
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
      <Panel id={`${projectId}-viewer`} defaultSize="32%" minSize="300px">
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
      <Panel id={`${projectId}-navigation`} defaultSize="18%" minSize="230px">
        <aside
          className="flex h-full min-w-0 flex-col"
          aria-label="Thread files and Git stage"
        >
          <Tabs defaultValue="files" className="min-h-0 flex-1 gap-0">
            <div className="flex items-center justify-between border-b">
              <TabsList variant="line" aria-label="Thread inspector">
                <TabsTrigger value="files">files</TabsTrigger>
                <TabsTrigger value="git">git stage</TabsTrigger>
              </TabsList>
              <button
                type="button"
                className="px-3 text-[11px] underline"
                disabled={!started}
                onClick={() => setRevision((v) => v + 1)}
              >
                refresh
              </button>
            </div>
            <TabsContent value="files" className="min-h-0 overflow-auto">
              {started ? (
                <RepositoryTree
                  key={revision}
                  files={files}
                  open={(path) => void open(path)}
                />
              ) : (
                <p className="p-4 text-xs text-muted-foreground">
                  Start a sandbox to browse files.
                </p>
              )}
            </TabsContent>
            <TabsContent value="git" className="overflow-auto p-3 text-xs">
              <p className="mb-3 text-[11px] text-muted-foreground">
                Stage and commit in the CLI. Refresh to review.
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
