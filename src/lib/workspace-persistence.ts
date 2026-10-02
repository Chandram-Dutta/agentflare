import type { ThreadState, ThreadStateStore } from "./thread-state";
import { attachmentSchema, attachmentLimit, encodedBytes } from "./acp-content";
import { z } from "zod";

const prefix = "agentflare:workspace:v1:";
const ttl = 7 * 24 * 60 * 60 * 1000;
const path = z.string().min(1).max(4096);
const position = z.number().finite().nonnegative().optional();
const preferences = z.object({
  layout: z.record(z.string(), z.number().finite().min(0).max(100)).optional(),
  sidebar: z.boolean().optional(),
  agent: z.boolean().optional(),
  reviewScrollTop: position,
  review: z
    .object({ reviewed: z.record(path, z.string().regex(/^[a-f0-9]{64}$/)) })
    .optional(),
  repository: z
    .object({
      files: z.array(z.string()).max(0),
      changes: z.array(z.never()).max(0),
      tab: z.string(),
      branchReviewOpen: z.boolean().optional(),
      selected: z
        .object({
          path,
          staged: z.union([z.boolean(), z.literal("branch")]).optional(),
        })
        .optional(),
      viewer: z
        .object({
          paths: z.array(path).max(30),
          active: path.optional(),
          cache: z.record(
            path,
            z.object({
              path,
              scrollTop: position,
              scrollLeft: position,
              startLine: position,
              endLine: position,
            }),
          ),
        })
        .optional(),
    })
    .optional(),
});
export type WorkspacePreferences = {
  layout?: Record<string, number>;
  sidebar?: boolean;
  agent?: boolean;
  reviewScrollTop?: number;
  review?: { reviewed: Record<string, string> };
  repository?: ThreadState["repository"];
};
type RecordValue = WorkspacePreferences & {
  updated: number;
  draft?: string;
  attachments?: ThreadState["attachments"];
  scroll?: number;
};

/** Origin is the installation boundary. Sensitive payloads never enter localStorage.
 * Session storage is plaintext, not an encrypted vault: same-origin scripts can read it.
 */
export class WorkspacePersistence {
  private scope: string;
  private stopped = false;
  private remove(storage: Storage, key: string) {
    try {
      storage.removeItem(key);
    } catch {
      this.warn(
        "Browser storage is unavailable; saved recovery data could not be cleared. Clear this site’s browser data manually.",
      );
    }
  }
  constructor(
    private durable: Storage,
    private session: Storage,
    account: string,
    private warn: (message: string) => void = () => {},
  ) {
    this.scope = `${prefix}${encodeURIComponent(account)}:`;
    for (const storage of [durable, session]) {
      for (const key of Object.keys(storage)) {
        if (key.startsWith(prefix) && !key.startsWith(this.scope))
          this.remove(storage, key);
      }
    }
  }
  read(id: string): WorkspacePreferences {
    const parsed = preferences.safeParse(this.load(this.durable, id));
    return parsed.success ? parsed.data : {};
  }
  private load(storage: Storage, id: string): RecordValue {
    try {
      const value = JSON.parse(storage.getItem(this.scope + id) ?? "null");
      if (
        value &&
        typeof value.updated === "number" &&
        Date.now() - value.updated < ttl
      )
        return value;
      storage.removeItem(this.scope + id);
    } catch {
      /* Corrupt or inaccessible storage is not authoritative. */
    }
    return { updated: Date.now() };
  }
  private write(storage: Storage, id: string, value: RecordValue) {
    if (this.stopped) return;
    try {
      const text = JSON.stringify(value);
      if (text.length > 2_100_000) throw Error("limit");
      storage.setItem(this.scope + id, text);
    } catch {
      try {
        storage.removeItem(this.scope + id);
      } catch {
        /* Best effort. */
      }
      this.warn(
        "Browser recovery storage is full or unavailable. Keep this tab open; recent drafts and attachments may not survive reload.",
      );
    }
  }
  patch(id: string, value: WorkspacePreferences) {
    const safe = preferences.safeParse({ ...this.read(id), ...value });
    if (!safe.success) return;
    this.write(this.durable, id, {
      ...safe.data,
      updated: Date.now(),
    });
  }
  forget(id: string) {
    for (const storage of [this.durable, this.session])
      this.remove(storage, this.scope + id);
  }
  clear() {
    this.stopped = true;
    for (const storage of [this.durable, this.session])
      for (const key of Object.keys(storage))
        if (key.startsWith(this.scope)) this.remove(storage, key);
  }
  connect(store: ThreadStateStore, ids: string[]) {
    const allowed = new Set(ids);
    for (const storage of [this.durable, this.session])
      for (const key of Object.keys(storage))
        if (
          key.startsWith(this.scope) &&
          !allowed.has(key.slice(this.scope.length))
        )
          this.remove(storage, key);
    for (const id of ids) {
      const saved = this.load(this.session, id);
      const ui = this.read(id);
      const attachments = attachmentSchema
        .array()
        .max(4)
        .refine((value) => encodedBytes(value) <= attachmentLimit)
        .safeParse(saved.attachments ?? []);
      if (!store.get(id).draft && !store.get(id).attachments?.length)
        store.update(id, {
          draft:
            typeof saved.draft === "string" ? saved.draft.slice(0, 16000) : "",
          attachments: attachments.success ? attachments.data : [],
          scroll:
            typeof saved.scroll === "number" && Number.isFinite(saved.scroll)
              ? saved.scroll
              : undefined,
        });
      if (!store.get(id).repository && ui.repository)
        store.update(id, { repository: ui.repository });
    }
    const previous = new Map<string, string>();
    const repositories = new Map<string, ThreadState["repository"]>();
    const save = () => {
      for (const id of ids) {
        const state = store.get(id);
        const sensitive = JSON.stringify([
          state.draft,
          state.attachments,
          state.scroll,
        ]);
        if (previous.get(id) !== sensitive) {
          previous.set(id, sensitive);
          this.write(this.session, id, {
            updated: Date.now(),
            draft: state.draft,
            attachments: state.attachments,
            scroll: state.scroll,
          });
        }
        if (state.repository && repositories.get(id) !== state.repository) {
          repositories.set(id, state.repository);
          const { viewer, tab, branchReviewOpen, selected } = state.repository;
          const paths = viewer
            ? viewer.paths.length <= 30
              ? viewer.paths
              : viewer.paths.filter(
                  (path, index) =>
                    path === viewer.active || index >= viewer.paths.length - 29,
                )
            : [];
          // Persist tab identities and positions, never source text, patches or transcripts.
          this.patch(id, {
            repository: {
              files: [],
              changes: [],
              tab,
              branchReviewOpen,
              selected,
              viewer: viewer && {
                paths,
                active: viewer.active,
                cache: Object.fromEntries(
                  paths.map((path) => {
                    const file = viewer.cache[path];
                    return [
                      path,
                      {
                        path,
                        scrollTop: file?.scrollTop,
                        scrollLeft: file?.scrollLeft,
                        startLine: file?.startLine,
                        endLine: file?.endLine,
                      },
                    ];
                  }),
                ),
              },
            },
          });
        }
      }
    };
    const unsubscribe = store.subscribe(save);
    return () => {
      save();
      unsubscribe();
    };
  }
}
