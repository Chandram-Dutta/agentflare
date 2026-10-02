"use client";

import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { File } from "@pierre/diffs/react";
import type { FileOptions } from "@pierre/diffs";
import { X } from "lucide-react";
import { ChatMarkdown } from "./chat-markdown";
import {
  CONTEXT_LIMIT,
  fileContext,
  textContext,
  type TextSelection,
  type RepositoryContext,
  type RepositoryViewer,
  type ViewerFile,
} from "@/lib/repository-viewer";
import type { RepositoryFileLink } from "@/lib/repository-links";
import { sourceSelection } from "@/lib/repository-selection";

export function RepositoryFileTabs({
  viewer,
  themeType,
  threadId,
  onOpenFile,
  onAddContext,
}: {
  viewer: RepositoryViewer;
  themeType: "light" | "dark";
  threadId: string;
  onOpenFile: (file: RepositoryFileLink) => void;
  onAddContext?: (context: RepositoryContext) => void;
}) {
  const state = useSyncExternalStore(
    viewer.subscribe,
    viewer.getSnapshot,
    viewer.getSnapshot,
  );
  const active = state.active ? state.cache[state.active] : undefined;
  const tablist = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    tablist.current
      ?.querySelector('[aria-selected="true"]')
      ?.parentElement?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [state.active, state.paths]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={tablist}
        className="flex h-10 shrink-0 overflow-x-auto border-b"
        role="tablist"
        aria-label="Open files"
      >
        {state.paths.map((path) => (
          <div
            key={path}
            className={`flex shrink-0 items-center border-r ${path === state.active ? "bg-muted border-b-2 border-b-primary" : "text-muted-foreground"}`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={path === state.active}
              tabIndex={path === state.active ? 0 : -1}
              title={path}
              className="max-w-48 truncate px-3 py-2 text-xs focus-visible:outline-2 focus-visible:outline-primary"
              onClick={() => viewer.open({ path })}
              onKeyDown={(event) => {
                const index = state.paths.indexOf(path);
                const next =
                  event.key === "ArrowRight"
                    ? (index + 1) % state.paths.length
                    : event.key === "ArrowLeft"
                      ? (index - 1 + state.paths.length) % state.paths.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? state.paths.length - 1
                          : undefined;
                if (next !== undefined) {
                  event.preventDefault();
                  viewer.open({ path: state.paths[next] });
                  const tabs = event.currentTarget
                    .closest('[role="tablist"]')
                    ?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
                  tabs?.[next]?.focus();
                }
              }}
            >
              {path.split("/").pop()}
            </button>
            <button
              type="button"
              aria-label={`Close ${path}`}
              title={`Close ${path}`}
              className="mr-1 p-1 hover:bg-background focus-visible:outline-2 focus-visible:outline-primary"
              onClick={() => viewer.close(path)}
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        {!active && (
          <span className="px-3 py-3 text-xs text-muted-foreground">
            file / diff
          </span>
        )}
      </div>
      {active ? (
        <FilePane
          key={active.path}
          file={active}
          viewer={viewer}
          themeType={themeType}
          threadId={threadId}
          onOpenFile={onOpenFile}
          onAddContext={onAddContext}
        />
      ) : (
        <p className="p-4 text-xs text-muted-foreground">
          Select a file or Git change to review it here.
        </p>
      )}
    </div>
  );
}

function FilePane({
  file,
  viewer,
  themeType,
  threadId,
  onOpenFile,
  onAddContext,
}: {
  file: ViewerFile;
  viewer: RepositoryViewer;
  themeType: "light" | "dark";
  threadId: string;
  onOpenFile: (file: RepositoryFileLink) => void;
  onAddContext?: (context: RepositoryContext) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const scrolled = useRef<number | undefined>(undefined);
  // Keep renderer inputs stable while the selection toolbar updates.
  const source = useMemo(
    () => ({ name: file.path, contents: file.content ?? "" }),
    [file.path, file.content],
  );
  const [contextError, setContextError] = useState("");
  function send(context: RepositoryContext) {
    try {
      onAddContext?.(context);
      setContextError("");
    } catch (error) {
      setContextError(
        error instanceof Error
          ? error.message
          : "Could not add context to chat.",
      );
    }
  }
  const [selection, setSelection] = useState<{
    content?: string;
    navigationId?: number;
    range: { start: number; end: number } | null;
    text?: TextSelection;
  }>({ content: file.content, navigationId: file.navigationId, range: null });
  // Invalidate before rendering actions, not after an effect: old text must never be sent.
  if (
    selection.content !== file.content ||
    selection.navigationId !== file.navigationId
  ) {
    setSelection({
      content: file.content,
      navigationId: file.navigationId,
      range: null,
    });
  }
  const range =
    selection.content === file.content &&
    selection.navigationId === file.navigationId
      ? selection.range
      : null;
  const text =
    selection.content === file.content &&
    selection.navigationId === file.navigationId
      ? selection.text
      : undefined;
  const full = fileContext(file);
  const excerpt = text
    ? textContext(file, text)
    : range
      ? fileContext(file, range)
      : undefined;
  const markdown = /\.(md|markdown|mdown)$/i.test(file.path);
  // Keep renderer options stable while native selection updates the toolbar.
  const options = useMemo<FileOptions<undefined, undefined>>(
    () => ({
      themeType,
      disableFileHeader: true,
      enableLineSelection: true,
      onLineSelected: (range) => {
        if (range)
          scroll.current?.ownerDocument.getSelection()?.removeAllRanges();
        setSelection({
          content: file.content,
          navigationId: file.navigationId,
          range,
        });
      },
      onPostRender: (node, _instance, phase) => {
        if (
          phase === "unmount" ||
          !file.startLine ||
          file.navigationId === scrolled.current
        )
          return;
        const line = node.shadowRoot?.querySelector<HTMLElement>(
          `[data-line="${file.startLine}"]`,
        );
        if (!line) return;
        line.scrollIntoView({ block: "center", inline: "nearest" });
        scrolled.current = file.navigationId;
        viewer.patch(file.path, { startLine: undefined, endLine: undefined });
        setSelection({
          content: file.content,
          navigationId: file.navigationId,
          range: { start: file.startLine, end: file.endLine ?? file.startLine },
        });
      },
    }),
    [
      themeType,
      file.content,
      file.path,
      file.navigationId,
      file.startLine,
      file.endLine,
      viewer,
    ],
  );
  useLayoutEffect(() => {
    if (file.preview) return;
    const container = scroll.current;
    const document = container?.ownerDocument;
    if (!document) return;
    const root = () => container.querySelector("diffs-container")?.shadowRoot;
    const read = () => {
      const shadow = root();
      const text = shadow ? sourceSelection(shadow) : undefined;
      setSelection((previous) =>
        text || previous.text
          ? {
              content: file.content,
              navigationId: file.navigationId,
              range: null,
              text,
            }
          : previous,
      );
    };
    document.addEventListener("selectionchange", read);
    return () => {
      document.removeEventListener("selectionchange", read);
      const shadow = root();
      if (shadow && sourceSelection(shadow))
        document.getSelection()?.removeAllRanges();
    };
  }, [file.content, file.navigationId, file.preview]);
  useLayoutEffect(() => {
    if (scroll.current) {
      scroll.current.scrollTop = file.scrollTop ?? 0;
      scroll.current.scrollLeft = file.scrollLeft ?? 0;
    }
    // Restore only on mount. Polling must not reset the user's position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const actionClass =
    "shrink-0 rounded px-2 py-1 hover:bg-muted disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-primary";
  return (
    <div
      role="tabpanel"
      aria-label={file.path}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b px-2 py-1 text-[11px]">
        <span
          title={file.path}
          className="min-w-20 flex-1 truncate text-muted-foreground"
        >
          {file.path}
        </span>
        {markdown && (
          <div className="flex" aria-label="Markdown view">
            {([false, true] as const).map((preview) => (
              <button
                key={String(preview)}
                type="button"
                aria-pressed={Boolean(file.preview) === preview}
                className={`${actionClass} ${Boolean(file.preview) === preview ? "bg-muted text-foreground" : "text-muted-foreground"}`}
                onClick={() => {
                  setSelection({
                    content: file.content,
                    navigationId: file.navigationId,
                    range: null,
                  });
                  viewer.patch(file.path, { preview });
                }}
              >
                {preview ? "Preview" : "Source"}
              </button>
            ))}
          </div>
        )}
        {onAddContext && (
          <>
            <button
              type="button"
              className={actionClass}
              disabled={!full}
              title={
                full
                  ? "Add file to chat"
                  : `File unavailable or over ${CONTEXT_LIMIT.toLocaleString()} characters; select fewer lines.`
              }
              onClick={() => {
                if (full) send(full);
              }}
            >
              Add file
            </button>
            {!file.preview && (
              <button
                type="button"
                className={actionClass}
                disabled={!excerpt}
                title={
                  (range || text) && !excerpt
                    ? "Selection too large or unavailable; select fewer lines."
                    : "Select text or line numbers, then add the selection to chat"
                }
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (excerpt) send(excerpt);
                }}
              >
                Add{" "}
                {text
                  ? "selection"
                  : range
                    ? `L${Math.min(range.start, range.end)}–${Math.max(range.start, range.end)}`
                    : "selection"}
              </button>
            )}
          </>
        )}
      </div>
      {contextError && (
        <p role="alert" className="border-b p-3 text-xs text-destructive">
          {contextError}
        </p>
      )}
      {file.error && (
        <p role="alert" className="border-b p-3 text-xs text-destructive">
          {file.error}{" "}
          <button
            type="button"
            className="underline"
            onClick={() => void viewer.load(file.path)}
          >
            Retry
          </button>
        </p>
      )}
      {file.content === undefined ? (
        !file.error && (
          <p role="status" className="p-4 text-xs">
            Loading {file.path}…
          </p>
        )
      ) : (
        <>
          {onAddContext && !file.preview && (
            <div className="flex shrink-0 items-center justify-between border-b px-3 py-1 text-[10px] text-muted-foreground">
              <span>
                Select text or line numbers · max{" "}
                {CONTEXT_LIMIT.toLocaleString()} characters
              </span>
              {(range || text) && (
                <button
                  type="button"
                  className="underline"
                  onClick={() => {
                    scroll.current?.ownerDocument
                      .getSelection()
                      ?.removeAllRanges();
                    setSelection({
                      content: file.content,
                      navigationId: file.navigationId,
                      range: null,
                    });
                  }}
                >
                  Clear selection
                </button>
              )}
            </div>
          )}
          <div
            ref={scroll}
            className="min-h-0 flex-1 overflow-auto"
            onScroll={(event) =>
              viewer.patch(file.path, {
                scrollTop: event.currentTarget.scrollTop,
                scrollLeft: event.currentTarget.scrollLeft,
              })
            }
          >
            {markdown && file.preview ? (
              <div className="p-4 text-xs">
                <ChatMarkdown threadId={threadId} onOpenFile={onOpenFile}>
                  {file.content}
                </ChatMarkdown>
              </div>
            ) : (
              <File file={source} selectedLines={range} options={options} />
            )}
          </div>
        </>
      )}
    </div>
  );
}
