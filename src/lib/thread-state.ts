import type { AcpAction, AcpActivity, AcpSnapshot, AcpContent } from "./acp";
import type { RuntimeState, BranchReview, GitChange } from "./runtime";
import { apiRequest } from "./api-client";

export type RepositoryState = {
  files: string[];
  changes: GitChange[];
  review?: BranchReview;
  view?: { path: string; content?: string; patch?: string; label: string };
  selected?: { path: string; staged?: boolean | "branch" };
  tab: string;
};
export type ThreadState = {
  runtime?: RuntimeState;
  snapshot?: AcpSnapshot;
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
// Nothing is persisted to localStorage (transcripts and drafts can be sensitive).
export class ThreadStateStore {
  private entries = new Map<string, ThreadState>();
  private listeners = new Set<() => void>();
  private versions = new Map<string, number>();
  private activityVersions = new Map<string, number>();
  private deleted = new Set<string>();
  private loads = new Map<string, Promise<void>>();
  private epoch = 0;
  private revision = 0;
  active?: string;
  private viewed?: string;
  activityError = false;
  constructor(private request: typeof apiRequest = apiRequest) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getRevision = () => this.revision;
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
    this.setActivity(id, {
      status: snapshot.status,
      attention: snapshot.permissions.length > 0 || Boolean(snapshot.login),
      turn:
        snapshot.messages.findLast((m) => m.role === "user")?.id ??
        this.get(id).activity?.turn,
    });
    const previous = this.get(id).snapshot;
    this.update(id, {
      snapshot:
        JSON.stringify(previous) === JSON.stringify(snapshot)
          ? previous
          : snapshot,
      error: "",
    });
  }
  private setActivity(id: string, activity: AcpActivity) {
    this.activityVersions.set(id, (this.activityVersions.get(id) ?? 0) + 1);
    const previous = this.get(id);
    const finished =
      activity.status === "ready" &&
      Boolean(activity.turn) &&
      (previous.activity?.turn !== activity.turn ||
        previous.activity?.status === "running");
    this.update(id, {
      activity:
        previous.activity?.status === activity.status &&
        previous.activity?.turn === activity.turn &&
        previous.activity?.attention === activity.attention
          ? previous.activity
          : activity,
      unread: id === this.viewed ? false : previous.unread || finished,
    });
  }
  async ensure(id: string) {
    if (this.loads.has(id)) return this.loads.get(id);
    if (this.get(id).runtime) return;
    const version = this.versions.get(id) ?? 0;
    const load = (async () => {
      try {
        const runtime = await this.request<RuntimeState>(
          `/threads/${id}/runtime/status`,
          "GET",
          undefined,
          AbortSignal.timeout(15000),
        );
        if ((this.versions.get(id) ?? 0) !== version) return;
        this.update(id, { runtime, error: "" });
        if (runtime.started && runtime.agent === "codex")
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
    this.update(id, { pending: true, error: "" });
    try {
      const snapshot = await this.request<AcpSnapshot>(
        `/threads/${id}/runtime/acp`,
        "POST",
        action,
      );
      if (this.versions.get(id) !== version) return false;
      this.accept(id, snapshot);
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
        this.update(id, { error: (error as Error).message });
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
