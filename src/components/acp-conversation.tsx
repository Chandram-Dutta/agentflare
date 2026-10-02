"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowUp,
  Bot,
  LogOut,
  Square,
  RotateCcw,
  Save,
  Pause,
  GitCompareArrows,
} from "lucide-react";
import { createPortal } from "react-dom";
import { Popover } from "@base-ui/react/popover";
import { Button } from "./ui/button";
import { AcpMessages } from "./acp-messages";
import { AcpComposerControls } from "./acp-composer-controls";
import { AcpAttachments } from "./acp-attachments";
import { AcpMentionInput } from "./acp-mention-input";
import { promptActionSchema } from "@/lib/acp-content";
import type { RepositoryLinkProps } from "./chat-markdown";
import type { AcpAction } from "@/lib/acp";
import { useThreadStore, useThreadState } from "./thread-state";
import { toast } from "./ui/toast";

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
  onOpenFile,
  onReviewChanges,
}: {
  threadId: string;
  headerTarget?: HTMLDivElement | null;
  onReviewChanges?: () => void;
} & RepositoryLinkProps) {
  const store = useThreadStore();
  const [attachmentReading, setAttachmentReading] = useState(false);
  const [sendError, setSendError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const {
    snapshot,
    runtime,
    repository,
    draft: prompt,
    attachments,
    error: networkError,
    pending: actionPending,
  } = useThreadState(threadId);
  const transcript = useRef<HTMLDivElement>(null);
  const action = (value: AcpAction) => store.action(threadId, value);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  async function saveWorkspace(type: "checkpoint" | "suspend") {
    let pendingToast: string | undefined;
    const timer = setTimeout(() => {
      pendingToast = toast.add({
        title:
          type === "checkpoint"
            ? "Saving checkpoint…"
            : "Saving and suspending…",
        type: "loading",
        timeout: 0,
      });
    }, 300);
    try {
      const ok = await action({ type });
      setNow(Date.now());
      toast.add({
        title: ok
          ? type === "checkpoint"
            ? "Checkpoint saved"
            : "Workspace suspended"
          : "Workspace save failed",
        type: ok ? "success" : "error",
        description: ok
          ? type === "checkpoint"
            ? "Your workspace is still running."
            : "Resume when you are ready to continue."
          : store.get(threadId).error,
      });
    } finally {
      clearTimeout(timer);
      if (pendingToast) toast.close(pendingToast);
    }
  }
  useLayoutEffect(() => {
    const element = transcript.current;
    if (element)
      element.scrollTop = store.get(threadId).scroll ?? element.scrollHeight;
    return () => {
      if (element) store.update(threadId, { scroll: element.scrollTop });
    };
  }, [store, threadId]);

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
    if (
      (!text && !attachments?.length) ||
      !canCompose ||
      actionPending ||
      attachmentReading
    )
      return;
    const payload = {
      type: "prompt",
      text,
      attachments,
      requestId: crypto.randomUUID(),
    } as const;
    if (!promptActionSchema.safeParse(payload).success) {
      setSendError(
        "Message or attachments exceed their limits. Shorten the message or remove context; nothing was sent.",
      );
      return;
    }
    if (
      attachments?.some((block) => block.type === "resource") &&
      !snapshot?.promptCapabilities?.embeddedContext
    ) {
      setSendError(
        "This agent does not support embedded context. Remove context before sending.",
      );
      return;
    }
    setSendError("");
    await action(payload);
  }

  const loginUrl = snapshot?.login ? safeLoginUrl(snapshot.login.url) : null;
  const saved = Boolean(snapshot?.saved);
  const stopped =
    saved || Boolean(snapshot?.workspace && snapshot.workspace !== "running");
  const idle = snapshot?.status === "ready" && !stopped;
  const sleeping = runtime?.autoResume && snapshot?.workspace === "suspended";
  const canCompose = idle || Boolean(sleeping);

  const status =
    snapshot?.workspace && snapshot.workspace !== "running"
      ? snapshot.workspace === "failed"
        ? "interrupted"
        : snapshot.workspace
      : saved
        ? "saved"
        : networkError && snapshot?.persistence?.state !== "error"
          ? "disconnected"
          : (snapshot?.status ?? "loading");
  const persistence = snapshot?.persistence;
  const savedAt = persistence?.savedAt
    ? new Date(persistence.savedAt).toLocaleString()
    : undefined;
  const ageMinutes = persistence?.savedAt
    ? Math.max(0, Math.floor((now - Date.parse(persistence.savedAt)) / 60_000))
    : 0;
  const checkpointAge = savedAt
    ? ageMinutes < 1
      ? "just now"
      : ageMinutes < 60
        ? `${ageMinutes}m ago`
        : ageMinutes < 1440
          ? `${Math.floor(ageMinutes / 60)}h ago`
          : `${Math.floor(ageMinutes / 1440)}d ago`
    : "no checkpoint yet";
  const canSave =
    snapshot?.workspace === "running" &&
    !["running", "connecting", "configuring", "authenticating"].includes(
      snapshot.status,
    ) &&
    !snapshot.permissions.length &&
    !snapshot.login;
  const savePending = persistence?.state === "saving";
  const persistenceLabel = persistence
    ? persistence.state === "saved"
      ? `saved ${checkpointAge}`
      : persistence.state === "saving"
        ? "saving checkpoint…"
        : persistence.state === "error"
          ? "save failed"
          : persistence.state === "dirty"
            ? "checkpoint pending"
            : "workspace saving disabled"
    : undefined;
  const controls = (
    <div className="flex flex-wrap items-center justify-end gap-1 text-muted-foreground">
      <Popover.Root>
        <Popover.Trigger
          aria-label={`Workspace details: ${status}`}
          title="Workspace details"
          className="flex h-6 items-center gap-1.5 rounded px-1 text-[10px] hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
        >
          <Bot className="size-3.5" aria-hidden="true" />
          <span
            className={`size-1.5 rounded-full ${idle && !networkError ? "bg-emerald-500" : "bg-primary"}`}
            aria-hidden="true"
          />
          {!idle && <span>{status}</span>}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner
            side="bottom"
            align="end"
            sideOffset={8}
            className="z-50"
          >
            <Popover.Popup className="max-w-[calc(100vw-24px)] rounded-md border bg-background p-3 text-xs shadow-lg">
              <Popover.Title>Codex · {status}</Popover.Title>
              <div className="mt-2 space-y-1 text-muted-foreground">
                {persistenceLabel && (
                  <p>
                    {persistenceLabel}
                    {savedAt ? ` · ${savedAt}` : ""}
                  </p>
                )}
                {snapshot?.timings?.startupMs !== undefined && (
                  <p>
                    Startup {(snapshot.timings.startupMs / 1000).toFixed(1)}s
                  </p>
                )}
                {snapshot?.timings?.resumeMs !== undefined && (
                  <p>Resume {(snapshot.timings.resumeMs / 1000).toFixed(1)}s</p>
                )}
                {persistence?.durationMs !== undefined && (
                  <p>
                    Save {(persistence.durationMs / 1000).toFixed(1)}s
                    {persistence.unchanged ? " · unchanged" : ""}
                  </p>
                )}
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {idle &&
          Boolean(repository?.review?.changes.length) &&
          onReviewChanges && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Review changes"
              title="Review changes"
              onClick={onReviewChanges}
            >
              <GitCompareArrows className="size-3" aria-hidden="true" />
            </Button>
          )}
        {persistenceLabel && persistence?.state === "error" && (
          <span
            className="hidden items-center gap-1 text-[10px] text-muted-foreground sm:flex"
            role="status"
            title={`Workspace checkpoint: ${persistenceLabel}. ${savedAt ? `Last complete save: ${savedAt}. ` : "No successful checkpoint yet. "}${persistence?.checkpointId ? `Checkpoint ${persistence.checkpointId}. ` : ""}Save checkpoint keeps the workspace running. Suspend saves first, then stops it. Checkpoints restore files, not running processes.`}
          >
            <Save className="size-3" aria-hidden="true" />
            {persistenceLabel}
          </span>
        )}
        {!stopped && snapshot?.status === "running" && (
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
            title="Sign out of Codex in all shared threads"
            disabled={actionPending}
            onClick={() => {
              if (
                window.confirm(
                  "Sign out of Codex across all your shared threads? Stop running tasks first. Your workspaces and conversations will remain.",
                )
              )
                void action({ type: "logout" });
            }}
          >
            <LogOut className="size-3" aria-hidden="true" />
          </Button>
        )}
        {snapshot?.workspace === "running" &&
          persistence?.state !== "disabled" && (
            <>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={
                  persistence?.state === "error"
                    ? "Retry save"
                    : "Save checkpoint"
                }
                title={
                  canSave
                    ? "Save files without stopping the workspace"
                    : "Wait for the agent to finish or stop the current operation before saving"
                }
                disabled={actionPending || savePending || !canSave}
                onClick={() => void saveWorkspace("checkpoint")}
              >
                <Save className="size-3" aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Suspend workspace"
                title="Save a checkpoint, then stop the workspace"
                disabled={actionPending || savePending || !canSave}
                onClick={() => void saveWorkspace("suspend")}
              >
                <Pause className="size-3" aria-hidden="true" />
              </Button>
            </>
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
          {snapshot && (
            <AcpMessages
              messages={snapshot.messages}
              threadId={threadId}
              onOpenFile={onOpenFile}
            />
          )}

          {!stopped && snapshot?.status === "auth-required" && (
            <div className="border p-3">
              <p className="mb-3 text-muted-foreground">
                Sign in once to use Codex across your shared threads.
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
                Your login is encrypted and saved for this account. New threads
                reuse it. OpenAI may still require reauthorization if access
                expires or is revoked.
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

          {(!stopped || sleeping) &&
            (snapshot?.error ||
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
          {snapshot?.status === "connecting" && !runtime?.autoResume && (
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
        {!stopped && persistence && persistence.state === "error" && (
          <p
            role="alert"
            className="mx-auto mb-2 max-w-3xl text-[11px] text-muted-foreground"
          >
            {runtime?.autoResume
              ? "Backup delayed. Your workspace is still running; saving retries automatically."
              : "Save failed. Working files remain here. Retry before suspending."}{" "}
            Last checkpoint: <span title={savedAt}>{checkpointAge}</span>.
            {persistence.failure && persistence.state === "error" && (
              <span className="block break-words select-text">
                Failed at {persistence.failure.stage}. Reference:{" "}
                {persistence.failure.reference}
              </span>
            )}
          </p>
        )}
        {stopped && !sleeping &&
          !(runtime?.autoResume && (snapshot?.workspace === "recovering" || snapshot?.workspace === "suspending")) && (
          <div className="mx-auto mb-2 w-full max-w-3xl rounded-md border bg-muted/30 p-3 text-muted-foreground">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p>
                {snapshot?.workspace === "failed"
                  ? "Workspace interrupted. Recover to continue; the last operation will not be rerun."
                  : snapshot?.workspace === "suspending"
                    ? "Saving workspace before suspension…"
                    : snapshot?.workspace === "recovering"
                      ? "Restoring workspace…"
                      : "Workspace suspended. Resume to continue."}
              </p>
              <Button
                type="button"
                variant="outline"
                className="h-7 rounded-md text-xs"
                disabled={
                  actionPending ||
                  snapshot?.workspace === "suspending" ||
                  snapshot?.workspace === "recovering"
                }
                onClick={() => void action({ type: "connect" })}
              >
                <RotateCcw className="mr-1 size-3" aria-hidden="true" />
                {snapshot?.workspace === "failed"
                  ? "Recover workspace"
                  : "Resume workspace"}
              </Button>
            </div>
            {snapshot?.interrupted && (
              <p className="mt-2">
                Previous operation may have been interrupted; it will not be
                rerun automatically.
              </p>
            )}
            {persistence && persistence.state !== "saved" && (
              <p className="mt-2">
                This history may be newer than saved files. Recovery keeps any
                surviving working files; a replacement runtime may lose work
                since the last checkpoint ({checkpointAge}).
              </p>
            )}
            {networkError && (
              <p role="alert" className="mt-2 text-destructive">
                {networkError}
              </p>
            )}
          </div>
        )}
        <AcpComposerControls
          options={snapshot?.configOptions}
          contextUsage={snapshot?.contextUsage}
          disabled={!idle || actionPending}
          onAction={(value) => void action(value)}
        />
        <AcpAttachments
          key={threadId}
          attachments={attachments ?? []}
          capabilities={snapshot?.promptCapabilities}
          disabled={!canCompose || actionPending}
          onChange={(next) => {
            const current = store.get(threadId);
            if (current.attachments !== attachments || current.pending)
              throw new Error(
                "Attachments changed while reading. Please try again.",
              );
            store.update(threadId, { attachments: next });
          }}
          onReadingChange={setAttachmentReading}
        />
        <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
          <AcpMentionInput
            key={threadId}
            threadId={threadId}
            disabled={!canCompose || actionPending || attachmentReading}
            placeholder={
              canCompose
                ? "Describe a developer task… @ to reference a file"
                : stopped
                  ? "Resume workspace to continue"
                  : "Codex is not ready"
            }
          />
          <Button
            type="submit"
            variant="outline"
            size="icon"
            aria-label="Send message"
            title="Send message (Ctrl/⌘ + Enter)"
            className="rounded-md"
            disabled={
              !canCompose ||
              actionPending ||
              attachmentReading ||
              (!prompt.trim() && !attachments?.length)
            }
          >
            <ArrowUp className="size-4" aria-hidden="true" />
          </Button>
        </div>
        {sendError && (
          <p role="alert" className="mx-auto mt-1 max-w-3xl text-destructive">
            {sendError}
          </p>
        )}
        <p className="mx-auto mt-1 flex w-full max-w-3xl items-center justify-between text-[10px] leading-4 text-muted-foreground">
          <span title="Ctrl/⌘ + Enter to send">⌘/Ctrl ↵</span>
          <span>{prompt.length}/16000</span>
        </p>
      </form>
    </section>
  );
}
