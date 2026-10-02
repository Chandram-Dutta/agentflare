import type { AcpAction, AcpActivity, AcpSnapshot, AcpContent } from "./acp";
import type { RuntimeState, BranchReview, GitChange } from "./runtime";
import { apiRequest } from "./api-client";
import {
  acpReadPath,
  readAcpUpdate,
  type AcpReadCursor,
  type AcpReadUpdate,
} from "./acp-transport";
import {
  notificationKind,
  type ThreadNotification,
} from "./thread-notifications";

export type RepositoryState = {
  files: string[];
  changes: GitChange[];
  review?: BranchReview;
  viewer?: import("./repository-viewer").ViewerState;
  branchReviewOpen?: boolean;
  view?: {
    path: string;
    content?: string;
    patch?: string;
    label: string;
    startLine?: number;
    endLine?: number;
    navigationId?: number;
  };
  selected?: { path: string; staged?: boolean | "branch" };
  tab: string;
};
export type ThreadState = {
  runtime?: RuntimeState;
  snapshot?: AcpSnapshot;
  hydrated?: boolean;
  draft: string;
  attachments?: AcpContent[];
  scroll?: number;
  pending: boolean;
  pendingAction?: AcpAction["type"] | "start";
  error: string;
  activity?: AcpActivity;
  unread: boolean;
  repository?: RepositoryState;
};
const empty: ThreadState = {
  draft: "",
  pending: false,
  error: "",
  unread: false,
};

// One owner per signed-in workspace; views subscribe without owning requests.
// Transcripts and drafts aren't persisted to localStorage; only the separate
// desktop-notification preference is stored there.
export class ThreadStateStore {
  private entries = new Map<string, ThreadState>();
  private listeners = new Set<() => void>();
  private notificationListeners = new Set<
    (event: ThreadNotification) => void
  >();
  private finishedTurns = new Map<string, string>();
  private versions = new Map<string, number>();
  private activityVersions = new Map<string, number>();
  private deleted = new Set<string>();
  private loads = new Map<string, Promise<void>>();
  private conversationRequests = new Map<string, number>();
  private cursors = new Map<string, AcpReadCursor>();
  private activityRequest = 0;
  private epoch = 0;
  private revision = 0;
  active?: string;
  private viewed?: string;
  activityError = false;
  notificationsEnabled = false;
  constructor(private request: typeof apiRequest = apiRequest) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getRevision = () => this.revision;
  subscribeNotifications = (listener: (event: ThreadNotification) => void) => {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  };
  setNotificationsEnabled(enabled: boolean) {
    if (this.notificationsEnabled === enabled) return;
    this.notificationsEnabled = enabled;
    this.emit();
  }
  get = (id: string) => this.entries.get(id) ?? empty;
  update(id: string, change: Partial<ThreadState>) {
    if (this.deleted.has(id)) return;
    if (
      Object.entries(change).every(([key, value]) =>
        Object.is(this.get(id)[key as keyof ThreadState], value),
      )
    )
      return;
    this.entries.set(id, { ...this.get(id), ...change });
    this.emit();
  }
  private emit() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
  forget(id: string) {
    this.deleted.add(id);
    this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
    this.entries.delete(id);
    this.finishedTurns.delete(id);
    this.loads.delete(id);
    this.cursors.delete(id);
    this.epoch++;
    this.emit();
  }
  select(id?: string, visible = true) {
    this.active = id;
    this.viewed = visible ? id : undefined;
    if (id && visible && this.get(id).unread)
      this.update(id, { unread: false });
  }
  private accept(id: string, snapshot: AcpSnapshot) {
    this.setActivity(
      id,
      {
        status: snapshot.status,
        workspace: snapshot.workspace,
        attention: snapshot.permissions.length > 0 || Boolean(snapshot.login),
        attentionId: snapshot.permissions[0]?.id ?? snapshot.login?.id,
        turnCancelled: snapshot.turnCancelled,
        turn:
          snapshot.messages.findLast((m) => m.role === "user")?.id ??
          this.get(id).activity?.turn,
      },
      snapshot.workspace !== undefined || !snapshot.saved,
    );
    const previous = this.get(id).snapshot;
    if (
      snapshot.status === "connecting" &&
      !snapshot.messages.length &&
      previous?.messages.length
    )
      snapshot = { ...snapshot, messages: previous.messages };
    this.update(id, {
      snapshot:
        JSON.stringify(previous) === JSON.stringify(snapshot)
          ? previous
          : snapshot,
      error: "",
    });
  }
  private setActivity(id: string, activity: AcpActivity, live = true) {
    // Historical transcripts are not observations of the running agent.
    if (!live) return;
    this.activityVersions.set(id, (this.activityVersions.get(id) ?? 0) + 1);
    if (activity.workspace && activity.workspace !== "running") {
      this.update(id, { activity });
      return;
    }
    const previous = this.get(id);
    const alreadyFinished = this.finishedTurns.get(id) === activity.turn;
    let kind = notificationKind(previous.activity, activity);
    if (kind === "finished" && alreadyFinished) kind = undefined;
    if (activity.status === "ready" && activity.turn)
      this.finishedTurns.set(id, activity.turn);
    const finished =
      !alreadyFinished &&
      activity.status === "ready" &&
      !activity.turnCancelled &&
      Boolean(activity.turn) &&
      (previous.activity?.turn !== activity.turn ||
        previous.activity?.status === "running");
    this.update(id, {
      activity:
        previous.activity?.status === activity.status &&
        previous.activity?.workspace === activity.workspace &&
        previous.activity?.turn === activity.turn &&
        previous.activity?.attention === activity.attention &&
        previous.activity?.turnCancelled === activity.turnCancelled &&
        previous.activity?.attentionId === activity.attentionId
          ? previous.activity
          : activity,
      unread: id === this.viewed ? false : previous.unread || finished,
    });
    if (kind && this.notificationsEnabled)
      for (const listener of this.notificationListeners)
        listener({ threadId: id, kind });
  }
  async ensure(id: string) {
    if (this.loads.has(id)) return this.loads.get(id);
    if (this.get(id).hydrated) return this.pollConversation(id);
    const version = this.versions.get(id) ?? 0;
    const load = (async () => {
      try {
        const [runtime, saved] = await Promise.all([
          this.request<RuntimeState>(
            `/threads/${id}/runtime/status`,
            "GET",
            undefined,
            AbortSignal.timeout(15000),
          ),
          this.request<AcpSnapshot | null>(
            `/threads/${id}/runtime/saved`,
            "GET",
            undefined,
            AbortSignal.timeout(15000),
          ),
        ]);
        if ((this.versions.get(id) ?? 0) !== version) return;
        this.update(id, {
          runtime,
          hydrated: true,
          error: "",
          ...(runtime.started && saved ? { snapshot: saved } : {}),
        });
        if (runtime.started && saved) this.accept(id, saved);
        if (
          runtime.started &&
          runtime.agent === "codex" &&
          !saved?.saved &&
          (!runtime.workspace || runtime.workspace === "running")
        )
          await this.action(id, { type: "connect" });
      } catch (error) {
        if ((this.versions.get(id) ?? 0) === version)
          this.update(id, {
            error: String(error instanceof Error ? error.message : error),
          });
      }
    })();
    this.loads.set(id, load);
    await load;
    if (this.loads.get(id) === load) this.loads.delete(id);
  }
  async start(id: string) {
    if (this.get(id).pending) return;
    const version = (this.versions.get(id) ?? 0) + 1;
    this.versions.set(id, version);
    this.update(id, { pending: true, pendingAction: "start", error: "" });
    try {
      const runtime = await this.request<RuntimeState>(
        `/threads/${id}/runtime/start`,
        "POST",
        {},
      );
      if (this.versions.get(id) !== version) return;
      this.update(id, { runtime, pending: false, pendingAction: undefined });
      if (runtime.agent === "codex") await this.action(id, { type: "connect" });
    } catch (error) {
      if (this.versions.get(id) === version)
        this.update(id, {
          pending: false,
          pendingAction: undefined,
          error: (error as Error).message,
        });
    }
  }
  async action(id: string, action: AcpAction) {
    if (this.get(id).pending) return false;
    this.cursors.delete(id);
    const version = (this.versions.get(id) ?? 0) + 1;
    this.versions.set(id, version);
    this.epoch++;
    const previousSnapshot = this.get(id).snapshot;
    // A connect from a checkpoint is an explicit resume. Remove the marker
    // immediately so conversation and repository polling can begin.
    this.update(id, {
      pending: true,
      pendingAction: action.type,
      error: "",
      ...((action.type === "suspend" || action.type === "checkpoint") &&
      previousSnapshot
        ? {
            snapshot: {
              ...previousSnapshot,
              ...(action.type === "suspend"
                ? { workspace: "suspending" as const }
                : {}),
              persistence: {
                ...previousSnapshot.persistence,
                state: "saving" as const,
              },
            },
          }
        : {}),
      ...(action.type === "connect" &&
      (previousSnapshot?.saved || previousSnapshot?.workspace)
        ? {
            snapshot: {
              ...previousSnapshot,
              saved: false,
              status: "connecting",
              ...(previousSnapshot.workspace
                ? { workspace: "recovering" as const }
                : {}),
            },
          }
        : {}),
    });
    try {
      const snapshot = await this.request<AcpSnapshot>(
        `/threads/${id}/runtime/acp`,
        "POST",
        action,
      );
      if (this.versions.get(id) !== version) return false;
      this.accept(
        id,
        action.type === "connect" &&
          snapshot.messages.length === 0 &&
          previousSnapshot?.messages.length
          ? { ...snapshot, messages: previousSnapshot.messages }
          : snapshot,
      );
      // Clear only the submitted draft, not text typed while the request ran.
      if (action.type === "prompt" && this.get(id).draft.trim() === action.text)
        this.update(id, { draft: "" });
      if (
        action.type === "prompt" &&
        this.get(id).attachments === action.attachments
      )
        this.update(id, { attachments: undefined });
      return true;
    } catch (error) {
      let recoveredSnapshot = previousSnapshot;
      if (
        (action.type === "suspend" || action.type === "checkpoint") &&
        previousSnapshot
      ) {
        // The server may have quiesced Codex before a later save stage failed.
        // Read the truth without reconnecting or replaying any action.
        recoveredSnapshot = await this.request<AcpSnapshot>(
          `/threads/${id}/runtime/acp`,
          "GET",
          undefined,
          AbortSignal.timeout(15000),
        ).catch(() => previousSnapshot);
      }
      if (this.versions.get(id) === version)
        this.update(id, {
          error: (error as Error).message,
          ...((action.type === "connect" ||
            action.type === "suspend" ||
            action.type === "checkpoint") &&
          previousSnapshot
            ? {
                snapshot: recoveredSnapshot,
                ...(recoveredSnapshot?.workspace
                  ? {
                      activity: {
                        ...this.get(id).activity,
                        status: recoveredSnapshot.status,
                        attention:
                          recoveredSnapshot.workspace === "failed" ||
                          recoveredSnapshot.permissions.length > 0 ||
                          Boolean(recoveredSnapshot.login),
                        workspace: recoveredSnapshot.workspace,
                      },
                    }
                  : {}),
              }
            : {}),
        });
      return false;
    } finally {
      this.epoch++;
      if (this.versions.get(id) === version)
        this.update(id, { pending: false, pendingAction: undefined });
    }
  }
  async pollConversation(id: string) {
    const state = this.get(id);
    if (
      !state.runtime?.started ||
      state.runtime.agent !== "codex" ||
      (state.activity?.workspace ?? state.snapshot?.workspace) ===
        "suspended" ||
      (state.snapshot?.saved && state.activity?.workspace !== "running") ||
      state.pending
    )
      return;
    const version = this.versions.get(id) ?? 0;
    const request = (this.conversationRequests.get(id) ?? 0) + 1;
    this.conversationRequests.set(id, request);
    const activityVersion = this.activityVersions.get(id);
    const current = () =>
      (this.versions.get(id) ?? 0) === version &&
      this.activityVersions.get(id) === activityVersion &&
      this.conversationRequests.get(id) === request;
    const cursor = this.cursors.get(id);
    try {
      const wire = await this.request<AcpReadUpdate>(
        acpReadPath(id, cursor),
        "GET",
        undefined,
        AbortSignal.timeout(15000),
      );
      if (!current()) return;
      const next = readAcpUpdate(cursor, wire);
      this.cursors.set(id, next);
      this.accept(id, next.snapshot);
    } catch (error) {
      if (current()) {
        this.cursors.delete(id);
        this.update(id, { error: (error as Error).message });
      }
    }
  }
  async pollActivity() {
    const epoch = this.epoch;
    const request = ++this.activityRequest;
    const versions = new Map(this.activityVersions);
    try {
      const activity = await this.request<Record<string, AcpActivity>>(
        "/activity",
        "GET",
        undefined,
        AbortSignal.timeout(15000),
      );
      if (epoch !== this.epoch || request !== this.activityRequest) return;
      this.activityError = false;
      for (const [id, value] of Object.entries(activity))
        if (
          !this.deleted.has(id) &&
          !this.get(id).pending &&
          versions.get(id) === this.activityVersions.get(id)
        )
          this.setActivity(id, value);
      for (const [id, state] of this.entries)
        if (
          state.activity &&
          !activity[id] &&
          !state.pending &&
          versions.get(id) === this.activityVersions.get(id)
        )
          this.update(id, { activity: undefined });
      this.emit();
    } catch {
      if (epoch !== this.epoch || request !== this.activityRequest) return;
      this.activityError = true;
      this.emit();
    }
  }
}

export function activityLabel(state: ThreadState, stale = false) {
  if (state.pending) {
    if (
      state.pendingAction === "checkpoint" ||
      state.pendingAction === "suspend" ||
      state.snapshot?.persistence?.state === "saving"
    )
      return "saving";
    if (state.pendingAction === "prompt") return "sending";
    if (state.pendingAction === "cancel") return "stopping";
    return "connecting";
  }
  if (state.error) return "failed";
  if (stale) return "unknown";
  const workspace = state.activity?.workspace ?? state.snapshot?.workspace;
  if (workspace && workspace !== "running")
    return workspace === "failed"
      ? "failed"
      : workspace === "suspending"
        ? "saving"
        : workspace;
  if (state.snapshot?.persistence?.state === "saving") return "saving";
  if (state.snapshot?.persistence?.state === "error") return "failed";
  const activity = state.activity;
  if (!activity) return state.snapshot?.saved ? "suspended" : "not connected";
  if (activity.status === "error") return "failed";
  if (
    activity.attention ||
    ["auth-required", "authenticating"].includes(activity.status)
  )
    return "waiting for user";
  if (activity.status === "running") return "working";
  if (activity.status === "ready" && activity.turn && !activity.turnCancelled)
    return "finished";
  return activity.status;
}

// Completion acknowledgment is separate from lifecycle: opening a result removes
// it from the inbox without making the completed thread look idle again.
export function attentionKind(
  state: ThreadState,
): "approval" | "failure" | "finished" | undefined {
  const label = activityLabel(state);
  if (label === "failed") return "failure";
  if (label === "waiting for user") return "approval";
  if (state.unread) return "finished";
}
