"use client";

import { useId, useState } from "react";
import { ChevronRight, Terminal } from "lucide-react";
import type { AcpMessage } from "@/lib/acp";
import { ChatMarkdown, type RepositoryLinkProps } from "./chat-markdown";
import { AcpContent } from "./acp-content";

function ToolMessage({ message }: { message: AcpMessage }) {
  const [expanded, setExpanded] = useState<boolean>();
  const outputId = useId();
  const open = expanded ?? message.status !== "completed";
  const newline = message.text.indexOf("\n");
  const title = newline < 0 ? message.text : message.text.slice(0, newline);
  const output = newline < 0 ? "" : message.text.slice(newline + 1);
  const active =
    message.status === "in_progress" || message.status === "pending";
  const failed = message.status === "failed" || message.status === "error";

  return (
    <div className="min-w-0 border-y border-border/70 bg-background/30">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={outputId}
        onClick={() => setExpanded(!open)}
        className="flex w-full min-w-0 items-start gap-2 px-2 py-2.5 text-left hover:bg-background/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <ChevronRight
          aria-hidden="true"
          className={`mt-0.5 size-3.5 shrink-0 text-muted-foreground ${open ? "rotate-90" : ""}`}
        />
        <Terminal
          aria-hidden="true"
          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 break-words leading-5">
          <span className="mr-2 text-[10px] text-muted-foreground">tool</span>
          {title || "Tool call"}
        </span>
        {message.status && (
          <span
            className={`shrink-0 pt-0.5 text-[10px] ${active || failed ? "text-primary" : "text-muted-foreground"}`}
          >
            <span aria-hidden="true" className="mr-1.5">
              {failed
                ? "!"
                : active
                  ? "◌"
                  : message.status === "completed"
                    ? "✓"
                    : "·"}
            </span>
            {message.status}
          </span>
        )}
      </button>
      <div id={outputId} hidden={!open} className="pb-3 pl-7 pr-2">
        {message.content?.length ? (
          <div
            tabIndex={0}
            role="region"
            aria-label={`Tool output: ${title || "Tool call"}`}
            className="max-h-72 overflow-auto border-l pl-3 pr-2"
          >
            <AcpContent blocks={message.content} literal />
          </div>
        ) : output ? (
          <pre
            tabIndex={0}
            role="region"
            aria-label={`Tool output: ${title || "Tool call"}`}
            className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-l pl-3 pr-2 font-mono text-[11px] leading-5 text-muted-foreground focus-visible:outline-2 focus-visible:outline-primary"
          >
            {output}
          </pre>
        ) : (
          <p className="border-l pl-3 text-[11px] text-muted-foreground">
            No output reported.
          </p>
        )}
      </div>
    </div>
  );
}

export function AcpMessages({
  messages,
  threadId,
  onOpenFile,
}: { messages: AcpMessage[] } & RepositoryLinkProps) {
  return (
    <div className="space-y-5">
      {messages.map((message) => {
        if (message.role === "tool")
          return <ToolMessage key={message.id} message={message} />;

        if (message.role === "thought")
          return (
            <details
              key={message.id}
              className="group min-w-0 pl-3 text-muted-foreground"
            >
              <summary className="flex cursor-pointer list-none items-center gap-2 text-[11px] focus-visible:outline-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden">
                <ChevronRight
                  aria-hidden="true"
                  className="size-3.5 group-open:rotate-90"
                />
                Thinking
                {message.status && (
                  <span className="text-[10px]">/ {message.status}</span>
                )}
              </summary>
              <div className="ml-1.5 mt-3 border-l pl-4">
                {message.content?.length ? (
                  <AcpContent
                    blocks={message.content}
                    threadId={threadId}
                    onOpenFile={onOpenFile}
                  />
                ) : (
                  <ChatMarkdown threadId={threadId} onOpenFile={onOpenFile}>
                    {message.text}
                  </ChatMarkdown>
                )}
              </div>
            </details>
          );

        return (
          <article
            key={message.id}
            className={
              message.role === "user"
                ? "border-l-2 border-primary bg-background/40 px-3 py-2"
                : "min-w-0 px-3"
            }
          >
            <header className="mb-2 flex items-center gap-2 text-[10px] text-muted-foreground">
              <span className={message.role === "user" ? "text-primary" : ""}>
                {message.role}
              </span>
              {message.status && <span>/ {message.status}</span>}
            </header>
            {message.content?.length ? (
              <AcpContent
                blocks={message.content}
                threadId={threadId}
                onOpenFile={onOpenFile}
              />
            ) : (
              <ChatMarkdown threadId={threadId} onOpenFile={onOpenFile}>
                {message.text}
              </ChatMarkdown>
            )}
          </article>
        );
      })}
    </div>
  );
}
