"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { useThreadState } from "./thread-state";
import { apiRequest } from "@/lib/api-client";
import {
  matchesQuery,
  navigationShortcut,
  searchConversation,
  searchLines,
} from "@/lib/workspace-search";
import { workspaceHref } from "@/lib/workspace-route";
import type { WorkspaceData, Thread } from "@/lib/workspace";
import type { RepositoryFileLink } from "@/lib/repository-links";

export function WorkspaceNavigation({
  data,
  thread,
  navigate,
  openFile,
  showConversation,
  newThread,
}: {
  data?: WorkspaceData;
  thread?: Thread;
  navigate: (href: string) => void;
  openFile: (file: RepositoryFileLink) => void;
  showConversation: () => void;
  newThread: () => void;
}) {
  const [mode, setMode] = useState<
    "switch" | "files" | "repository" | "conversation"
  >();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const [hits, setHits] = useState<ReturnType<typeof searchLines>>([]);
  const [status, setStatus] = useState("");
  const [resultQuery, setResultQuery] = useState("");
  const state = useThreadState(thread?.id ?? "");
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const shortcut = navigationShortcut(event);
      if (!shortcut || event.repeat) return;
      event.preventDefault();
      setQuery("");
      setIndex(0);
      setMode(shortcut);
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);
  useEffect(() => {
    if (!mode || !thread || (mode !== "files" && mode !== "repository")) return;
    const controller = new AbortController();
    apiRequest<{ files: string[] }>(
      `/threads/${thread.id}/runtime/files`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        setFiles(result.files);
        setStatus("");
      })
      .catch((error) => {
        if (!controller.signal.aborted) setStatus(error.message);
      });
    return () => controller.abort();
  }, [mode, thread]);
  useEffect(() => {
    if (mode !== "repository" || !query.trim() || !thread) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setHits([]);
      setStatus("Searching file contents…");
      const results: ReturnType<typeof searchLines> = [];
      let failures = 0;
      const paths = files.slice(0, 100);
      for (let i = 0; i < paths.length && !controller.signal.aborted; i += 4) {
        await Promise.all(
          paths.slice(i, i + 4).map(async (path) => {
            try {
              const value = await apiRequest<{ content?: string }>(
                `/threads/${thread.id}/runtime/file?path=${encodeURIComponent(path)}`,
                "GET",
                undefined,
                controller.signal,
              );
              if (value.content)
                results.push(...searchLines(path, value.content, query));
            } catch {
              failures++;
            }
          }),
        );
      }
      if (!controller.signal.aborted) {
        setHits(results.slice(0, 100));
        setResultQuery(query);
        setStatus(
          `Searched ${paths.length} files${files.length > 100 ? " (first 100 only)" : ""}${failures ? `; ${failures} unreadable` : ""}.`,
        );
      }
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [files, mode, query, thread]);
  const close = (action: () => void) => () => {
    setMode(undefined);
    action();
  };
  const results: { label: string; action: () => void }[] =
    mode === "switch"
      ? [
          ...(data?.projects ?? []).map((project) => ({
            label: `Project · ${project.name}`,
            action: () => navigate(workspaceHref(project.id)),
          })),
          ...(data?.threads ?? []).map((item) => ({
            label: `${data?.projects.find((p) => p.id === item.projectId)?.name} / ${item.name}`,
            action: () => navigate(workspaceHref(item.projectId, item.id)),
          })),
          { label: "Action · New thread", action: newThread },
          {
            label: "Action · Search conversation",
            action: () => {
              setQuery("");
              setIndex(0);
              setMode("conversation");
            },
          },
          {
            label: "Action · Search repository contents",
            action: () => {
              setQuery("");
              setIndex(0);
              setMode("repository");
            },
          },
        ].filter((result) => matchesQuery(result.label, query))
      : mode === "files"
        ? files
            .filter((path) => matchesQuery(path, query))
            .slice(0, 100)
            .map((path) => ({ label: path, action: () => openFile({ path }) }))
        : mode === "conversation"
          ? searchConversation(state.snapshot?.messages ?? [], query).map(
              (message) => ({
                label: `${message.role}: ${message.text}`,
                action: () => {
                  showConversation();
                  setTimeout(() => {
                    const element = document.getElementById(
                      `message-${message.id}`,
                    );
                    if (element instanceof HTMLDetailsElement)
                      element.open = true;
                    element?.scrollIntoView({ block: "center" });
                  }, 100);
                },
              }),
            )
          : (query.trim() && resultQuery === query ? hits : []).map((hit) => ({
              label: `${hit.path}:${hit.startLine} · ${hit.text}`,
              action: () => openFile(hit),
            }));
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Search and switch (Ctrl or Command K)"
        title="Search and switch · ⌘/Ctrl K"
        onClick={() => {
          setQuery("");
          setIndex(0);
          setMode("switch");
        }}
      >
        <Search className="size-4" />
      </Button>
      <Dialog
        open={Boolean(mode)}
        onOpenChange={(open) => {
          if (!open) setMode(undefined);
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogTitle>Search and switch</DialogTitle>
          <DialogDescription>
            ⌘/Ctrl K switches threads. ⌘/Ctrl P opens files.
          </DialogDescription>
          <div className="flex flex-wrap gap-1">
            {(["switch", "files", "conversation", "repository"] as const).map(
              (value) => (
                <Button
                  key={value}
                  size="sm"
                  variant={mode === value ? "secondary" : "ghost"}
                  disabled={value !== "switch" && !thread}
                  onClick={() => {
                    setMode(value);
                    setQuery("");
                    setIndex(0);
                  }}
                >
                  {value}
                </Button>
              ),
            )}
          </div>
          <input
            autoFocus
            aria-label="Search query"
            placeholder={
              mode === "repository"
                ? "Search text in repository files…"
                : "Type to search…"
            }
            className="w-full rounded-md border bg-transparent p-2 font-mono text-xs"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setIndex((i) =>
                  Math.max(
                    0,
                    Math.min(
                      results.length - 1,
                      i + (event.key === "ArrowDown" ? 1 : -1),
                    ),
                  ),
                );
              }
              if (event.key === "Enter" && results[index]) {
                event.preventDefault();
                close(results[index].action)();
              }
            }}
          />
          <p role="status" className="text-xs text-muted-foreground">
            {!thread && mode !== "switch"
              ? "Choose a thread first."
              : mode === "conversation"
                ? "Searches this thread’s loaded conversation."
                : status}
          </p>
          <div
            className="max-h-[45dvh] overflow-auto"
            aria-label="Search results"
          >
            {results.length ? (
              results.map((result, i) => (
                <button
                  key={`${i}-${result.label.slice(0, 60)}`}
                  className={`block w-full truncate rounded px-3 py-2 text-left font-mono text-xs ${i === index ? "bg-muted" : "hover:bg-muted"}`}
                  onClick={close(result.action)}
                >
                  {result.label}
                </button>
              ))
            ) : (
              <p className="p-3 text-xs text-muted-foreground">
                {query ? "No matches." : "Type a search query."}
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
