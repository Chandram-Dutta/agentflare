"use client";

import { useEffect, useId, useRef, useState } from "react";
import { FileText } from "lucide-react";
import { apiRequest } from "@/lib/api-client";
import {
  activeMention,
  appendRepositoryContext,
  createRepositoryReference,
} from "@/lib/repository-context";
import { useThreadState, useThreadStore } from "./thread-state";

export function AcpMentionInput({
  threadId,
  disabled,
  placeholder,
}: {
  threadId: string;
  disabled: boolean;
  placeholder: string;
}) {
  const store = useThreadStore();
  const { draft, repository, snapshot } = useThreadState(threadId);
  const [mention, setMention] = useState<ReturnType<typeof activeMention>>();
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState("");
  const loading = !repository && !error;
  const input = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const open = Boolean(mention) && !disabled;
  const supported = Boolean(snapshot?.promptCapabilities?.embeddedContext);
  const matches = (repository?.files ?? [])
    .filter((path) =>
      path.toLowerCase().includes(mention?.query.toLowerCase() ?? ""),
    )
    .slice(0, 8);
  const index = Math.min(selected, Math.max(0, matches.length - 1));

  useEffect(() => {
    if (!open || !supported) return;
    const controller = new AbortController();
    apiRequest<{ files: string[] }>(
      `/threads/${threadId}/runtime/files`,
      "GET",
      undefined,
      controller.signal,
    )
      .then(({ files }) => {
        if (controller.signal.aborted) return;
        const latest = store.get(threadId).repository;
        store.update(threadId, {
          repository: latest
            ? { ...latest, files }
            : { files, changes: [], tab: "files" },
        });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error
              ? error.message
              : "Could not load repository files.",
          );
      });
    return () => controller.abort();
  }, [open, supported, store, threadId]);

  function choose(path: string) {
    const current = store.get(threadId);
    if (
      !mention ||
      disabled ||
      current.pending ||
      current.snapshot?.status !== "ready" ||
      current.snapshot.saved
    )
      return;
    try {
      const nextDraft =
        current.draft.slice(0, mention.start) +
        current.draft.slice(mention.end);
      const attachments = appendRepositoryContext(
        current.attachments,
        createRepositoryReference(path),
        current.snapshot.promptCapabilities,
        nextDraft,
      );
      store.update(threadId, { attachments, draft: nextDraft });
      setMention(undefined);
      setError("");
      input.current?.focus();
    } catch (error) {
      setError((error as Error).message);
    }
  }

  return (
    <div className="min-w-0 flex-1">
      {open && (
        <div className="mb-2 rounded-md border bg-background p-1 text-[11px]">
          <p id={`${id}-help`} className="px-2 py-1 text-muted-foreground">
            Repository reference · ↑↓ choose · Enter attach · Esc dismiss
          </p>
          {!supported ? (
            <p role="alert" className="px-2 py-1 text-destructive">
              This agent does not support embedded repository context.
            </p>
          ) : (
            <>
              {loading && !repository && (
                <p role="status" className="px-2 py-1">
                  Loading repository files…
                </p>
              )}
              {!loading && !matches.length && (
                <p role="status" className="px-2 py-1">
                  No matching files.
                </p>
              )}
              <ul id={id} role="listbox" aria-label="Repository files">
                {matches.map((path, position) => (
                  <li
                    key={path}
                    id={`${id}-${position}`}
                    role="option"
                    aria-selected={position === index}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(path)}
                    className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 ${position === index ? "bg-muted text-foreground" : "text-muted-foreground"}`}
                  >
                    <FileText className="size-3 shrink-0" aria-hidden="true" />
                    <span className="break-all">{path}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mb-1 text-[11px] text-destructive">
          {error}
        </p>
      )}
      <textarea
        ref={input}
        aria-label="Message Codex"
        aria-autocomplete="list"
        aria-controls={open && supported ? id : undefined}
        aria-activedescendant={
          open && supported && matches.length ? `${id}-${index}` : undefined
        }
        aria-describedby={open ? `${id}-help` : undefined}
        value={draft}
        maxLength={16000}
        rows={2}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => {
          store.update(threadId, { draft: event.target.value });
          setMention(
            activeMention(event.target.value, event.target.selectionStart),
          );
          setSelected(0);
          setError("");
        }}
        onClick={(event) => {
          setMention(
            activeMention(
              event.currentTarget.value,
              event.currentTarget.selectionStart,
            ),
          );
          setSelected(0);
        }}
        onBlur={() => setMention(undefined)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (open && event.key === "Escape") {
            event.preventDefault();
            setMention(undefined);
            return;
          }
          if (
            open &&
            supported &&
            matches.length &&
            ["ArrowDown", "ArrowUp", "Enter"].includes(event.key)
          ) {
            event.preventDefault();
            if (event.key === "Enter") choose(matches[index]);
            else
              setSelected(
                (index +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  matches.length) %
                  matches.length,
              );
            return;
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            setMention(undefined);
        }}
        className="min-h-12 w-full resize-y border bg-background p-2 leading-5 outline-offset-2 focus-visible:outline-primary disabled:opacity-60"
      />
    </div>
  );
}
