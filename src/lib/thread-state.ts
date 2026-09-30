import type { AcpAction, AcpActivity, AcpSnapshot, AcpContent } from "./acp";
import type { RuntimeState, BranchReview, GitChange } from "./runtime";
import { apiRequest } from "./api-client";
import {
  notificationKind,
  type ThreadNotification,
} from "./thread-notifications";

export type RepositoryState = {
  files: string[];
  changes: GitChange[];
  review?: BranchReview;
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
        attention: snapshot.permissions.length > 0 || Boolean(snapshot.login),
        attentionId: snapshot.permissions[0]?.id ?? snapshot.login?.id,
        turnCancelled: snapshot.turnCancelled,
        turn:
          snapshot.messages.findLast((m) => m.role === "user")?.id ??
          this.get(id).activity?.turn,
      },
      !snapshot.saved,
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
    const previous = this.get(id);
    let kind = notificationKind(previous.activity, activity);
    if (kind === "finished" && this.finishedTurns.get(id) === activity.turn)
      kind = undefined;
    if (activity.status === "ready" && activity.turn)
      this.finishedTurns.set(id, activity.turn);
    const finished =
      activity.status === "ready" &&
      !activity.turnCancelled &&
      Boolean(activity.turn) &&
      (previous.activity?.turn !== activity.turn ||
        previous.activity?.status === "running");
    this.update(id, {
      activity:
        previous.activity?.status === activity.status &&
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
    if (this.get(id).hydrated) return;
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
        if (runtime.started && runtime.agent === "codex" && !saved?.saved)
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
    this.update(id, { pending: true, error: "" });
    try {
      const runtime = await this.request<RuntimeState>(
        `/threads/${id}/runtime/start`,
        "POST",
        {},
      );
      if (this.versions.get(id) !== version) return;
      this.update(id, { runtime, pending: false });
      if (runtime.agent === "codex") await this.action(id, { type: "connect" });
    } catch (error) {
      if (this.versions.get(id) === version)
        this.update(id, { pending: false, error: (error as Error).message });
    }
  }
  async action(id: string, action: AcpAction) {
    if (this.get(id).pending) return false;
    const version = (this.versions.get(id) ?? 0) + 1;
    this.versions.set(id, version);
    this.epoch++;
    const previousSnapshot = this.get(id).snapshot;
    // A connect from a checkpoint is an explicit resume. Remove the marker
    // immediately so conversation and repository polling can begin.
    this.update(id, {
      pending: true,
      error: "",
      ...(action.type === "connect" && previousSnapshot?.saved
        ? {
            snapshot: {
              ...previousSnapshot,
              saved: false,
              status: "connecting",
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
      if (this.versions.get(id) === version)
        this.update(id, {
          error: (error as Error).message,
          ...(action.type === "connect" && previousSnapshot?.saved
            ? { snapshot: previousSnapshot }
            : {}),
        });
      return false;
    } finally {
      this.epoch++;
      if (this.versions.get(id) === version)
        this.update(id, { pending: false });
    }
  }
  async pollConversation(id: string) {
    const state = this.get(id);
    if (
      !state.runtime?.started ||
      state.runtime.agent !== "codex" ||
      state.snapshot?.saved ||
      state.pending
    )
      return;
    const version = this.versions.get(id) ?? 0;
    try {
      const snapshot = await this.request<AcpSnapshot>(
        `/threads/${id}/runtime/acp`,
        "GET",
        undefined,
        AbortSignal.timeout(15000),
      );
      if ((this.versions.get(id) ?? 0) === version) this.accept(id, snapshot);
    } catch (error) {
      if ((this.versions.get(id) ?? 0) === version)
        this.update(id, { error: (error as Error).message });
    }
  }
  async pollActivity() {
    const epoch = this.epoch;
    const versions = new Map(this.activityVersions);
    try {
      const activity = await this.request<Record<string, AcpActivity>>(
        "/activity",
        "GET",
        undefined,
        AbortSignal.timeout(15000),
      );
      if (epoch !== this.epoch) return;
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
      this.activityError = true;
      this.emit();
    }
  }
}

export function activityLabel(state: ThreadState, stale = false) {
  if (state.pending) return "connecting";
  if (stale || state.error) return "unknown";
  const activity = state.activity;
  if (!activity) return "not connected";
  if (
    activity.attention ||
    ["auth-required", "authenticating"].includes(activity.status)
  )
    return "needs attention";
  if (activity.status === "ready" && state.unread) return "finished";
  return activity.status;
}
