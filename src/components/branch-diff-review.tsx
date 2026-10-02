"use client";

import {
  Component,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { PatchDiff } from "@pierre/diffs/react";
import { toast } from "./ui/toast";
import {
  ChevronDown,
  ChevronRight,
  Columns2,
  GitBranch,
  List,
  MessageSquarePlus,
  RefreshCw,
} from "lucide-react";
import type { BranchReview } from "../lib/runtime";
import {
  loadBranchDiffs,
  patchKind,
  type DiffResult,
} from "./branch-diff-review-loader";

export type BranchDiffReviewProps = {
  base: string;
  review: BranchReview;
  themeType: "light" | "dark";
  onAddContext?: (context: {
    kind: "file" | "selection" | "diff";
    path: string;
    content: string;
    startLine?: number;
    endLine?: number;
  }) => void;
};

const control =
  "inline-flex shrink-0 items-center justify-center gap-1 rounded px-2 py-1.5 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40";
const statuses: Record<string, string> = {
  A: "Added",
  D: "Deleted",
  M: "Modified",
  T: "Type changed",
  R: "Renamed",
  C: "Copied",
};

export function BranchDiffReview(props: BranchDiffReviewProps) {
  const [style, setStyle] = useState<"unified" | "split">("unified");
  const [refresh, setRefresh] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // A new snapshot unmounts the old queue and its results synchronously. Display
  // preferences stay outside that boundary, including across explicit refreshes.
  const identity = JSON.stringify([
    props.base,
    props.review.baseBranch,
    props.review.branch,
    props.review.revision,
    props.review.changes,
  ]);
  return (
    <section
      aria-label="Branch diff review"
      className="flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground text-xs"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b px-2 py-1">
        <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
        <span
          className="min-w-0 flex-1 truncate"
          title={`${props.review.baseBranch} ← ${props.review.branch}`}
        >
          {props.review.baseBranch} ← {props.review.branch}
        </span>
        <div role="group" aria-label="Diff display" className="flex gap-0.5">
          <button
            type="button"
            className={`${control} ${style === "unified" ? "bg-muted" : ""}`}
            aria-pressed={style === "unified"}
            onClick={() => setStyle("unified")}
          >
            <List className="size-3.5" aria-hidden="true" />
            Unified
          </button>
          <button
            type="button"
            className={`${control} ${style === "split" ? "bg-muted" : ""}`}
            aria-pressed={style === "split"}
            onClick={() => setStyle("split")}
          >
            <Columns2 className="size-3.5" aria-hidden="true" />
            Split
          </button>
        </div>
        <button
          type="button"
          className={control}
          aria-label="Refresh branch diffs"
          title="Reload diffs for the listed files"
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      <ReviewFiles
        key={`${identity}:${refresh}`}
        {...props}
        style={style}
        collapsed={collapsed}
        setCollapsed={setCollapsed}
      />
    </section>
  );
}

function ReviewFiles({
  base,
  review,
  themeType,
  onAddContext,
  style,
  collapsed,
  setCollapsed,
}: BranchDiffReviewProps & {
  style: "unified" | "split";
  collapsed: Set<string>;
  setCollapsed: React.Dispatch<React.SetStateAction<Set<string>>>;
}) {
  const [results, setResults] = useState<Record<string, DiffResult>>({});
  const loader = useRef<ReturnType<typeof loadBranchDiffs> | null>(null);
  const files = useRef(new Map<string, HTMLButtonElement>());
  const id = useId();
  useEffect(() => {
    const queue = loadBranchDiffs(
      base,
      review.changes.map((file) => file.path),
      (path, result) =>
        setResults((current) => ({ ...current, [path]: result })),
    );
    loader.current = queue;
    return () => queue.cancel();
    // The parent keys this component by base and the complete review identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const finished = Object.values(results).filter(
    (result) => result.state === "ready",
  ).length;
  const failures = Object.values(results).filter(
    (result) => result.state === "error",
  ).length;
  const toggle = (path: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <span role="status" className="text-muted-foreground">
          {finished}/{review.changes.length} loaded
          {failures ? ` · ${failures} failed` : ""}
        </span>
        {review.changes.length > 0 && (
          <>
            <select
              aria-label="Jump to changed file"
              className="min-w-32 flex-1 bg-background p-1"
              value=""
              onChange={(event) => {
                const path = event.target.value;
                setCollapsed((current) => {
                  const next = new Set(current);
                  next.delete(path);
                  return next;
                });
                files.current.get(path)?.scrollIntoView({ block: "start" });
                files.current.get(path)?.focus({ preventScroll: true });
              }}
            >
              <option value="" disabled>
                Jump to file…
              </option>
              {review.changes.map((file) => (
                <option key={file.path} value={file.path}>
                  {file.path}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={control}
              onClick={() => setCollapsed(new Set())}
            >
              Expand all
            </button>
            <button
              type="button"
              className={control}
              onClick={() =>
                setCollapsed(new Set(review.changes.map((file) => file.path)))
              }
            >
              Collapse all
            </button>
          </>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto" aria-label="Changed files">
        {!review.changes.length && (
          <p className="p-6 text-muted-foreground">
            No changes in this branch review.
          </p>
        )}
        {review.changes.map((file, index) => {
          const result = Object.hasOwn(results, file.path)
            ? results[file.path]
            : undefined;
          const expanded = !collapsed.has(file.path);
          const patch = result?.state === "ready" ? result.patch : undefined;
          return (
            <article
              key={file.path}
              aria-label={file.path}
              className="min-w-0 border-b"
            >
              <div className="flex items-center gap-2 bg-muted px-2 py-1">
                <button
                  type="button"
                  ref={(node) => {
                    if (node) files.current.set(file.path, node);
                    else files.current.delete(file.path);
                  }}
                  className={`${control} min-w-0 flex-1 justify-start text-left`}
                  aria-expanded={expanded}
                  aria-controls={`${id}-${index}`}
                  onClick={() => toggle(file.path)}
                >
                  {expanded ? (
                    <ChevronDown
                      className="size-3.5 shrink-0"
                      aria-hidden="true"
                    />
                  ) : (
                    <ChevronRight
                      className="size-3.5 shrink-0"
                      aria-hidden="true"
                    />
                  )}
                  <span className="truncate" title={file.path}>
                    {file.path}
                  </span>
                  <span className="ml-auto shrink-0 text-muted-foreground">
                    {statuses[file.status[0]] ?? file.status}
                  </span>
                </button>
                {onAddContext && (
                  <button
                    type="button"
                    className={control}
                    aria-label={`Add diff for ${file.path} to context`}
                    title={
                      patch?.trim()
                        ? "Add whole file diff to context"
                        : "No patch available to add"
                    }
                    disabled={!patch?.trim()}
                    onClick={() => {
                      if (!patch?.trim()) return;
                      try {
                        onAddContext({
                          kind: "diff",
                          path: file.path,
                          content: patch,
                        });
                        toast.add({
                          id: "repository-context",
                          type: "success",
                          timeout: 5000,
                          title: "Diff added to chat",
                          description: file.path,
                        });
                      } catch (error) {
                        toast.add({
                          id: "repository-context",
                          title: "Could not add diff",
                          type: "error",
                          timeout: 10000,
                          description:
                            error instanceof Error
                              ? error.message
                              : "Could not add diff to context. Try again.",
                        });
                      }
                    }}
                  >
                    <MessageSquarePlus
                      className="size-3.5"
                      aria-hidden="true"
                    />
                  </button>
                )}
              </div>
              <div id={`${id}-${index}`} hidden={!expanded}>
                {expanded &&
                  (!result || result.state === "loading" ? (
                    <p className="p-4 text-muted-foreground">Loading diff…</p>
                  ) : result.state === "error" ? (
                    <div role="alert" className="flex items-center gap-2 p-4">
                      <span className="min-w-0 flex-1 break-words">
                        {result.message}
                      </span>
                      <button
                        type="button"
                        className={control}
                        aria-label={`Retry diff for ${file.path}`}
                        onClick={() => loader.current?.retry(file.path)}
                      >
                        <RefreshCw className="size-3.5" aria-hidden="true" />
                        Retry
                      </button>
                    </div>
                  ) : (
                    <DiffBody
                      patch={result.patch}
                      style={style}
                      themeType={themeType}
                    />
                  ))}
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}

function DiffBody({
  patch,
  style,
  themeType,
}: {
  patch: string;
  style: "unified" | "split";
  themeType: "light" | "dark";
}) {
  const kind = patchKind(patch);
  if (kind === "empty")
    return (
      <p className="p-4 text-muted-foreground">
        No patch returned for this file. It may have changed since this review
        was loaded.
      </p>
    );
  if (kind === "binary")
    return (
      <p className="p-4 text-muted-foreground">
        Binary file changed. No text preview is available.
      </p>
    );
  if (kind === "metadata")
    return (
      <div className="p-4">
        <p className="mb-2 text-muted-foreground">
          No line changes. File metadata is shown below.
        </p>
        <pre className="overflow-x-auto">{patch}</pre>
      </div>
    );
  return (
    <DiffFallback key={patch} patch={patch}>
      <PatchDiff
        patch={patch}
        options={{
          diffStyle: style,
          themeType,
          disableFileHeader: true,
          overflow: "scroll",
        }}
      />
    </DiffFallback>
  );
}

class DiffFallback extends Component<
  { patch: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="p-4">
        <p className="mb-2 text-muted-foreground">
          Unable to render this patch. Raw diff:
        </p>
        <pre className="overflow-x-auto">{this.props.patch}</pre>
      </div>
    ) : (
      this.props.children
    );
  }
}
