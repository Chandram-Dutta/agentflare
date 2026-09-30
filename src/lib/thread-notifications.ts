import type { AcpActivity } from "./acp";

export type ThreadNotification = {
  threadId: string;
  kind: "finished" | "attention";
};

// The first observation is a baseline, so reopening a workspace doesn't notify
// for old results or pending approvals. Only subsequent live changes count.
export function notificationKind(
  previous: AcpActivity | undefined,
  next: AcpActivity,
): ThreadNotification["kind"] | undefined {
  if (!previous) return;
  if (
    next.attention &&
    (!previous.attention || next.attentionId !== previous.attentionId)
  )
    return "attention";
  if (
    !next.attention &&
    !next.turnCancelled &&
    next.status === "ready" &&
    next.turn &&
    (previous.status === "running" || previous.turn !== next.turn)
  )
    return "finished";
}

export function showThreadNotification(
  event: ThreadNotification,
  label: string,
  openThread: () => void,
): Notification | undefined {
  if (
    typeof window === "undefined" ||
    !("Notification" in window) ||
    !window.isSecureContext ||
    Notification.permission !== "granted" ||
    !document.hidden
  )
    return;
  // Some browsers expose permission but don't support the desktop constructor.
  // A notification failure must never interrupt workspace updates.
  try {
    const notification = new Notification(
      event.kind === "finished"
        ? "Codex finished"
        : "Codex needs your attention",
      {
        body: `${label} — ${event.kind === "finished" ? "Your turn is complete." : "An approval or sign-in is waiting."}`,
        tag: `agentflare-${event.threadId}-${event.kind}`,
        icon: "/icon.png",
      },
    );
    notification.onclick = () => {
      notification.close();
      window.focus();
      openThread();
    };
    return notification;
  } catch {
    return;
  }
}
