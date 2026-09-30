"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUp, SquareTerminal, LogOut, Square } from "lucide-react";
import { createPortal } from "react-dom";
import { Button } from "./ui/button";
import { AcpMessages } from "./acp-messages";
import { AcpComposerControls } from "./acp-composer-controls";
import type { AcpAction, AcpSnapshot } from "@/lib/acp";
import { apiRequest } from "@/lib/api-client";

const POLL_INTERVAL = 1000;

function safeLoginUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (url.hostname === "auth.openai.com" || url.hostname === "chatgpt.com")
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function AcpConversation({
  threadId,
  headerTarget,
}: {
  threadId: string;
  headerTarget?: HTMLDivElement | null;
}) {
  const [snapshot, setSnapshot] = useState<AcpSnapshot>();
  const [prompt, setPrompt] = useState("");
  const [networkError, setNetworkError] = useState("");
  const [actionPending, setActionPending] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const transcript = useRef<HTMLDivElement>(null);
  const base = `/threads/${threadId}/runtime/acp`;

  async function action(value: AcpAction) {
    const request = ++generation.current;
    setActionPending(true);
    setNetworkError("");
    try {
      const result = await apiRequest<AcpSnapshot>(base, "POST", value);
      if (mounted.current && request === generation.current)
        setSnapshot(result);
      return true;
    } catch (error) {
      if (mounted.current && request === generation.current) {
        setNetworkError(
          error instanceof Error ? error.message : "Request failed.",
        );
      }
      return false;
    } finally {
      if (mounted.current && request === generation.current)
        setActionPending(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    const request = ++generation.current;
    void apiRequest<AcpSnapshot>(base, "POST", { type: "connect" }).then(
      (result) => {
        if (mounted.current && request === generation.current)
          setSnapshot(result);
      },
      (error: unknown) => {
        if (mounted.current && request === generation.current)
          setNetworkError(
            error instanceof Error ? error.message : "Connection failed.",
          );
      },
    );
    return () => {
      mounted.current = false;
      // Invalidate any GET or POST that resolves after this keyed mount ends.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
    };
  }, [base]);

  useEffect(() => {
    if (networkError) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const request = generation.current;
      try {
        const result = await apiRequest<AcpSnapshot>(base);
        if (!cancelled && request === generation.current) setSnapshot(result);
      } catch (error) {
        if (!cancelled && request === generation.current)
          setNetworkError(
            error instanceof Error ? error.message : "Connection lost.",
          );
        return;
      }
      if (!cancelled) timer = setTimeout(poll, POLL_INTERVAL);
    };
    timer = setTimeout(poll, POLL_INTERVAL);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [base, networkError]);

  useEffect(() => {
    const element = transcript.current;
    if (!element) return;
    const nearBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < 100;
    if (nearBottom)
      requestAnimationFrame(() =>
        element.scrollTo({ top: element.scrollHeight }),
      );
  }, [snapshot?.messages]);

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || snapshot?.status !== "ready" || actionPending) return;
    const sent = await action({
      type: "prompt",
      text,
      requestId: crypto.randomUUID(),
    });
    if (sent) setPrompt("");
  }

  const loginUrl = snapshot?.login ? safeLoginUrl(snapshot.login.url) : null;
  const idle = snapshot?.status === "ready";

  const status = networkError
    ? "disconnected"
    : (snapshot?.status ?? "loading");
  const controls = (
    <div className="flex items-center gap-1 text-muted-foreground">
      <span
        role="status"
        aria-label={`Codex: ${status}`}
        title={`Codex: ${status}`}
        className="flex items-center gap-1.5 px-1 text-[10px]"
      >
        <SquareTerminal className="size-3.5" aria-hidden="true" />
        <span
          className={`size-1.5 rounded-full ${idle && !networkError ? "bg-emerald-500" : "bg-primary"}`}
          aria-hidden="true"
        />
        <span>{status}</span>
      </span>
      <div className="flex items-center gap-2">
        {snapshot?.status === "running" && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Stop Codex"
            title="Stop Codex"
            disabled={actionPending}
            onClick={() => void action({ type: "cancel" })}
          >
            <Square className="size-3" aria-hidden="true" />
          </Button>
        )}
        {idle && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Sign out of Codex"
            title={
              snapshot?.authScope === "user"
                ? "Sign out of Codex in all shared threads"
                : "Sign out of Codex"
            }
            disabled={actionPending}
            onClick={() => {
              if (
                window.confirm(
                  snapshot?.authScope === "user"
                    ? "Sign out of Codex across all your shared threads? Stop running tasks first. Your workspaces and conversations will remain."
                    : "Sign out of native Codex in this sandbox?",
                )
              )
                void action({ type: "logout" });
            }}
          >
            <LogOut className="size-3" aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--terminal)] text-xs"
      aria-label="Codex conversation"
    >
      {headerTarget ? createPortal(controls, headerTarget) : controls}

      <div ref={transcript} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-5">
          {snapshot?.authPersistence === "pending" && (
            <p role="status" className="text-primary">
              Codex login backup is pending. Keep this workspace running until
              it is saved.
            </p>
          )}
          {snapshot?.truncated && (
            <p className="text-muted-foreground">
              Showing recent output. Long messages may be shortened.
            </p>
          )}
          {!snapshot && !networkError && (
            <p role="status" className="text-muted-foreground">
              connecting to Codex…
            </p>
          )}
          {snapshot?.messages.length === 0 && idle && (
            <p className="text-muted-foreground">
              Codex is ready. Send a developer task below.
            </p>
          )}
          {snapshot && <AcpMessages messages={snapshot.messages} />}

          {snapshot?.status === "auth-required" && (
            <div className="border p-3">
              <p className="mb-3 text-muted-foreground">
                {snapshot.authScope === "user"
                  ? "Sign in once to use Codex across your shared threads."
                  : "Sign in to native Codex for this legacy sandbox."}
              </p>
              <Button
                variant="outline"
                className="rounded-none text-xs"
                disabled={actionPending}
                onClick={() => void action({ type: "authenticate" })}
              >
                Sign in with ChatGPT
              </Button>
              <p className="mt-3 text-[11px] leading-4 text-muted-foreground">
                {snapshot.authScope === "user"
                  ? "Your login is encrypted and saved for this account. New threads reuse it. OpenAI may still require reauthorization if access expires or is revoked."
                  : "This older thread keeps its own login. New Codex threads share one account login; this thread's files are not moved."}
              </p>
            </div>
          )}

          {snapshot?.login && (
            <div className="border p-3">
              <p className="whitespace-pre-wrap break-words leading-5">
                {snapshot.login.message}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                {loginUrl ? (
                  <a
                    href={loginUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-2"
                    onClick={() =>
                      void action({
                        type: "login-response",
                        id: snapshot.login!.id,
                        action: "accept",
                      })
                    }
                  >
                    open OpenAI sign-in
                  </a>
                ) : (
                  <span role="alert" className="text-destructive">
                    OpenAI returned an unsafe sign-in URL.
                  </span>
                )}
                <button
                  type="button"
                  className="text-muted-foreground underline"
                  disabled={actionPending}
                  onClick={() =>
                    void action({
                      type: "login-response",
                      id: snapshot.login!.id,
                      action: "cancel",
                    })
                  }
                >
                  cancel sign-in
                </button>
              </div>
              <p className="mt-3 text-[11px] text-muted-foreground">
                Waiting for Codex to confirm authentication. Opening the link
                does not complete sign-in by itself.
              </p>
            </div>
          )}

          {snapshot?.permissions.map((permission) => (
            <div key={permission.id} className="border p-3">
              <p className="mb-3 whitespace-pre-wrap break-words">
                {permission.title}
              </p>
              <div className="flex flex-wrap gap-2">
                {permission.options.map((option) => (
                  <Button
                    key={option.optionId}
                    variant="outline"
                    className="h-7 rounded-none text-xs"
                    disabled={actionPending}
                    onClick={() =>
                      void action({
                        type: "permission",
                        id: permission.id,
                        optionId: option.optionId,
                      })
                    }
                  >
                    {option.name}
                  </Button>
                ))}
              </div>
            </div>
          ))}

          {(snapshot?.error ||
            networkError ||
            snapshot?.status === "disconnected") && (
            <div
              role="alert"
              className="border border-destructive/40 p-3 text-destructive"
            >
              <p>
                {networkError ||
                  snapshot?.error ||
                  "Codex is disconnected. Reconnect to continue."}
              </p>
              <Button
                variant="outline"
                className="mt-3 rounded-none text-xs"
                disabled={actionPending}
                onClick={() => void action({ type: "connect" })}
              >
                reconnect
              </Button>
            </div>
          )}
          {snapshot?.status === "connecting" && (
            <p role="status" className="text-muted-foreground">
              starting Codex session…
            </p>
          )}
          {snapshot?.status === "authenticating" && !snapshot.login && (
            <p role="status" className="text-muted-foreground">
              waiting for authentication…
            </p>
          )}
        </div>
      </div>

      <form onSubmit={send} className="border-t px-3 py-2">
        <AcpComposerControls
          options={snapshot?.configOptions}
          contextUsage={snapshot?.contextUsage}
          disabled={!idle || actionPending}
          onAction={(value) => void action(value)}
        />
        <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
          <textarea
            aria-label="Message Codex"
            value={prompt}
            maxLength={16000}
            rows={2}
            disabled={!idle || actionPending}
            placeholder={
              idle ? "Describe a developer task…" : "Codex is not ready"
            }
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
                event.currentTarget.form?.requestSubmit();
            }}
            className="min-h-12 min-w-0 flex-1 resize-y border bg-background p-2 leading-5 outline-offset-2 focus-visible:outline-primary disabled:opacity-60"
          />
          <Button
            type="submit"
            variant="outline"
            size="icon"
            aria-label="Send message"
            title="Send message (Ctrl/⌘ + Enter)"
            className="rounded-md"
            disabled={!idle || actionPending || !prompt.trim()}
          >
            <ArrowUp className="size-4" aria-hidden="true" />
          </Button>
        </div>
        <p className="mx-auto mt-1 flex w-full max-w-3xl items-center justify-between text-[10px] leading-4 text-muted-foreground">
          <span title="Ctrl/⌘ + Enter to send">⌘/Ctrl ↵</span>
          <span>{prompt.length}/16000</span>
        </p>
      </form>
    </section>
  );
}
