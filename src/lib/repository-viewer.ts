import type { RepositoryFileLink } from "./repository-links";
import {
  REPOSITORY_CONTEXT_LIMIT,
  type RepositoryContext,
} from "./repository-context";
export type { RepositoryContext } from "./repository-context";

export type ViewerFile = RepositoryFileLink & {
  content?: string;
  error?: string;
  preview?: boolean;
  scrollTop?: number;
  scrollLeft?: number;
  navigationId?: number;
};
export type ViewerState = {
  paths: string[];
  active?: string;
  cache: Record<string, ViewerFile>;
};

export const CONTEXT_LIMIT = REPOSITORY_CONTEXT_LIMIT;

export type SourcePosition = { line: number; column: number };
export type TextSelection = { start: SourcePosition; end: SourcePosition };

/** DOM columns are UTF-16 offsets; slice the source, not rendered/normalized text. */
export function textContext(
  file: ViewerFile,
  selection: TextSelection,
): RepositoryContext | undefined {
  if (file.content === undefined || file.error) return;
  const lines = file.content.split("\n");
  function offset(position: SourcePosition) {
    const { line, column } = position;
    if (
      !Number.isSafeInteger(line) ||
      !Number.isSafeInteger(column) ||
      line < 1 ||
      line > lines.length ||
      column < 0 ||
      column > lines[line - 1].replace(/\r$/, "").length
    )
      return;
    return (
      lines
        .slice(0, line - 1)
        .reduce((sum, value) => sum + value.length + 1, 0) + column
    );
  }
  const a = offset(selection.start);
  const b = offset(selection.end);
  if (a === undefined || b === undefined || a === b) return;
  const start = Math.min(a, b);
  const end = Math.max(a, b);
  if (end - start > CONTEXT_LIMIT) return;
  return {
    kind: "selection",
    path: file.path,
    content: file.content.slice(start, end),
    startLine: file.content.slice(0, start).split("\n").length,
    // An endpoint at column zero excludes that line.
    endLine: file.content.slice(0, end - 1).split("\n").length,
  };
}

/** Only complete, explicitly selected lines are sent; never silently truncate a range. */
export function fileContext(
  file: ViewerFile,
  range?: { start: number; end: number } | null,
): RepositoryContext | undefined {
  if (file.content === undefined || file.error) return;
  if (!range) {
    if (file.content.length > CONTEXT_LIMIT) return;
    return { kind: "file", path: file.path, content: file.content };
  }
  const startLine = Math.min(range.start, range.end);
  const endLine = Math.max(range.start, range.end);
  const lines = file.content.split("\n");
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine > lines.length
  )
    return;
  const content = lines.slice(startLine - 1, endLine).join("\n");
  if (content.length > CONTEXT_LIMIT) return;
  return { kind: "selection", path: file.path, content, startLine, endLine };
}

/** Per-inspector request owner. Reads fill their cache entry, never change focus. */
export class RepositoryViewer {
  private state: ViewerState;
  private listeners = new Set<() => void>();
  private requests = new Map<string, Promise<void>>();
  private navigation = 0;
  constructor(
    initial: ViewerState | undefined,
    private read: (path: string) => Promise<{ content?: string }>,
  ) {
    this.state = initial ?? { paths: [], cache: {} };
    this.navigation = Math.max(
      0,
      ...Object.values(this.state.cache).map((file) => file.navigationId ?? 0),
    );
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(state: ViewerState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  patch(path: string, change: Partial<ViewerFile>) {
    const file = this.state.cache[path];
    if (!file) return;
    if (
      Object.entries(change).every(([key, value]) =>
        Object.is(file[key as keyof ViewerFile], value),
      )
    )
      return;
    this.update({
      ...this.state,
      cache: { ...this.state.cache, [path]: { ...file, ...change } },
    });
  }
  open(file: RepositoryFileLink) {
    const { path } = file;
    const cached = this.state.cache[path];
    this.update({
      ...this.state,
      active: path,
      paths: this.state.paths.includes(path)
        ? this.state.paths
        : [...this.state.paths, path],
      cache: {
        ...this.state.cache,
        [path]: {
          ...cached,
          path,
          ...(file.startLine
            ? { ...file, preview: false, navigationId: ++this.navigation }
            : {}),
        },
      },
    });
    if (cached?.content === undefined || cached.error) void this.load(path);
  }
  close(path: string) {
    const index = this.state.paths.indexOf(path);
    const paths = this.state.paths.filter((value) => value !== path);
    this.update({
      ...this.state,
      paths,
      active:
        this.state.active === path
          ? paths[Math.min(index, paths.length - 1)]
          : this.state.active,
    });
  }
  async load(path: string) {
    const pending = this.requests.get(path);
    if (pending) return pending;
    const request = (async () => {
      try {
        const result = await this.read(path);
        if (result.content === undefined)
          throw Error("No text content available.");
        this.patch(path, { content: result.content, error: undefined });
      } catch (error) {
        this.patch(path, {
          error: error instanceof Error ? error.message : "Read failed.",
        });
      }
    })();
    this.requests.set(path, request);
    await request;
    if (this.requests.get(path) === request) this.requests.delete(path);
  }
  async refresh() {
    await Promise.all(this.state.paths.map((path) => this.load(path)));
  }
}
