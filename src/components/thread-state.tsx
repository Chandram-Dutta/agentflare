"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Circle, CircleCheck, CircleAlert, LoaderCircle } from "lucide-react";
import { ThreadStateStore, activityLabel } from "@/lib/thread-state";

const Context = createContext<ThreadStateStore | null>(null);
export function ThreadStateProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new ThreadStateStore());
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let activityAt = 0;
    let running = false;
    async function tick() {
      if (cancelled || running) return;
      running = true;
      if (!document.hidden || store.notificationsEnabled) {
        if (Date.now() >= activityAt) {
          activityAt = Date.now() + (document.hidden ? 10000 : 3000);
          await store.pollActivity();
        }
        if (!cancelled && !document.hidden && store.active)
          await store.pollConversation(store.active);
      }
      running = false;
      if (!cancelled) timer = setTimeout(tick, 1000);
    }
    const visible = () => {
      if (!document.hidden) {
        activityAt = 0;
        clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener("visibilitychange", visible);
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [store]);
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
export function useThreadStore() {
  const store = useContext(Context);
  if (!store) throw Error("ThreadStateProvider missing");
  return store;
}
export function useThreadState(id: string) {
  const store = useThreadStore();
  return useSyncExternalStore(
    store.subscribe,
    () => store.get(id),
    () => store.get(id),
  );
}
export function ThreadActivity({
  ids,
  compact = false,
}: {
  ids: string[];
  compact?: boolean;
}) {
  const store = useThreadStore();
  useSyncExternalStore(store.subscribe, store.getRevision, () => 0);
  const labels = ids.map((id) =>
    activityLabel(store.get(id), store.activityError),
  );
  const shown = compact
    ? [...new Set(labels)].filter(
        (label) => !["ready", "not connected"].includes(label),
      )
    : [labels[0] ?? "not connected"];
  return (
    <span className="inline-flex items-center gap-2">
      {shown.map((label) => (
        <ActivityBadge
          key={label}
          label={label}
          count={
            compact
              ? labels.filter((value) => value === label).length
              : undefined
          }
        />
      ))}
    </span>
  );
}

function ActivityBadge({ label, count }: { label: string; count?: number }) {
  const Icon =
    label === "running" || label === "connecting" || label === "configuring"
      ? LoaderCircle
      : label === "finished"
        ? CircleCheck
        : ["needs attention", "error", "unknown"].includes(label)
          ? CircleAlert
          : Circle;
  const title = count === undefined ? label : `${count} ${label}`;
  return (
    <span
      title={title}
      aria-label={title}
      className={`inline-flex items-center gap-1.5 text-[10px] ${label === "finished" ? "text-emerald-600 dark:text-emerald-400" : ["needs attention", "error"].includes(label) ? "text-primary" : "text-muted-foreground"}`}
    >
      <Icon
        aria-hidden="true"
        className={`size-3 shrink-0 ${Icon === LoaderCircle ? "motion-safe:animate-spin" : ""}`}
      />
      {count ?? label}
    </span>
  );
}
