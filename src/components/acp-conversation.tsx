"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "./ui/button";
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

export function AcpConversation({ threadId }: { threadId: string }) {
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

  return (
    <section
      className="flex min-h-0 flex-1 flex-col bg-[var(--terminal)] text-xs"
      aria-label="Codex conversation"
    >
      <div className="flex min-h-9 items-center justify-between gap-3 border-b px-3">
        <span className="text-[11px] text-muted-foreground">
          codex / {snapshot?.status ?? "loading"}
        </span>
        <div className="flex items-center gap-2">
          {snapshot?.status === "running" && (
            <Button
              variant="outline"
              className="h-7 rounded-none text-xs"
              disabled={actionPending}
              onClick={() => void action({ type: "cancel" })}
            >
              stop
            </Button>
          )}
          {idle && (
            <Button
              variant="ghost"
              className="h-7 rounded-none text-xs font-normal"
              disabled={actionPending}
              onClick={() => {
                if (window.confirm("Sign out of native Codex in this sandbox?"))
                  void action({ type: "logout" });
              }}
            >
              sign out
            </Button>
          )}
        </div>
      </div>

      <div ref={transcript} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-5">
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
          {snapshot?.messages.map((message) =>
            message.role === "thought" ? (
              <details key={message.id} className="pl-3 text-muted-foreground">
                <summary className="cursor-pointer text-[10px]">Thinking</summary>
                <p className="mt-1 whitespace-pre-wrap break-words leading-5">
                  {message.text}
                </p>
              </details>
            ) : (
              <article
                key={message.id}
                className={
                  message.role === "user"
                    ? "border-l-2 border-primary pl-3"
                    : "pl-3"
                }
              >
                <header className="mb-1 text-[10px] text-muted-foreground">
                  {message.role}
                  {message.status ? ` / ${message.status}` : ""}
                </header>
                <p className="whitespace-pre-wrap break-words leading-5">
                  {message.text}
                </p>
              </article>
            ),
          )}

          {snapshot?.status === "auth-required" && (
            <div className="border p-3">
              <p className="mb-3 text-muted-foreground">
                Sign in to native Codex for this sandbox.
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
                Sign-in survives browser reloads, but replacing the sandbox can
                require signing in again.
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

      <form onSubmit={send} className="border-t p-3">
        <div className="mx-auto mb-2 flex w-full max-w-3xl flex-wrap items-end gap-x-3 gap-y-2">
          {snapshot?.configOptions?.map((option) => {
            const selected = option.options.find(
              (choice) => choice.value === option.currentValue,
            );
            return (
              <label
                key={option.id}
                className="flex min-w-28 flex-col gap-1 text-[10px] text-muted-foreground"
                title={option.description ?? selected?.description}
              >
                {option.name}
                <select
                  value={option.currentValue}
                  disabled={!idle || actionPending}
                  onChange={(event) =>
                    void action({
                      type: "set-config",
                      configId: option.id,
                      value: event.currentTarget.value,
                    })
                  }
                  className="h-7 max-w-48 border bg-background px-1 text-xs text-foreground disabled:opacity-60"
                >
                  {option.options.map((choice) => (
                    <option
                      key={choice.value}
                      value={choice.value}
                      title={choice.description}
                    >
                      {choice.name}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
          <div
            className="ml-auto min-w-36 text-[10px] text-muted-foreground"
            title="Last Codex-reported context estimate; not cumulative billable tokens or ChatGPT plan quota."
          >
            {snapshot?.contextUsage ? (
              <>
                <div className="mb-1 flex justify-between gap-2">
                  <span>context (last reported)</span>
                  <span>
                    {snapshot.contextUsage.used.toLocaleString()} /{" "}
                    {snapshot.contextUsage.size.toLocaleString()} ({Math.round(
                      (snapshot.contextUsage.used / snapshot.contextUsage.size) *
                        100,
                    )}%)
                  </span>
                </div>
                <progress
                  className="h-1 w-full"
                  max={snapshot.contextUsage.size}
                  value={Math.min(
                    snapshot.contextUsage.used,
                    snapshot.contextUsage.size,
                  )}
                />
              </>
            ) : (
              <span>context unavailable — not yet reported</span>
            )}
          </div>
        </div>
        <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
          <textarea
            aria-label="Message Codex"
            value={prompt}
            maxLength={16000}
            rows={3}
            disabled={!idle || actionPending}
            placeholder={
              idle ? "Describe a developer task…" : "Codex is not ready"
            }
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
                event.currentTarget.form?.requestSubmit();
            }}
            className="min-h-16 min-w-0 flex-1 resize-y border bg-background p-2 leading-5 outline-offset-2 focus-visible:outline-primary disabled:opacity-60"
          />
          <Button
            type="submit"
            variant="outline"
            className="rounded-none text-xs"
            disabled={!idle || actionPending || !prompt.trim()}
          >
            send
          </Button>
        </div>
        <p className="mx-auto mt-1 w-full max-w-3xl text-[10px] text-muted-foreground">
          Ctrl/⌘ + Enter to send · {prompt.length}/16000
        </p>
      </form>
    </section>
  );
}
