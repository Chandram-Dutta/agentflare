"use client";

import { useEffect, useSyncExternalStore } from "react";
import { attentionKind } from "@/lib/thread-state";
import type { Project, Thread } from "@/lib/workspace";
import { showThreadNotification } from "@/lib/thread-notifications";
import { ActivityBadge, useThreadStore } from "./thread-state";

type Props = {
  projects: Project[];
  threads: Thread[];
  onSelect: (thread: Thread) => void;
};

export function ThreadNotifications({ projects, threads, onSelect }: Props) {
  const store = useThreadStore();
  useEffect(() => {
    const notifications = new Set<Notification>();
    const unsubscribe = store.subscribeNotifications((event) => {
      const thread = threads.find((item) => item.id === event.threadId);
      const project = projects.find((item) => item.id === thread?.projectId);
      if (!thread || !project) return;
      const notification = showThreadNotification(
        event,
        `${project.name} / ${thread.name}`,
        () => onSelect(thread),
      );
      if (notification) {
        notifications.add(notification);
        notification.onclose = () => notifications.delete(notification);
      }
    });
    return () => {
      unsubscribe();
      for (const notification of notifications) notification.close();
    };
  }, [store, projects, threads, onSelect]);
  return null;
}

export function ThreadAttentionInbox({ projects, threads, onSelect }: Props) {
  const store = useThreadStore();
  useSyncExternalStore(store.subscribe, store.getRevision, () => 0);
  const priority = { approval: 0, failure: 1, finished: 2 };
  const items = threads
    .flatMap((thread) => {
      const kind = attentionKind(store.get(thread.id));
      const project = projects.find((item) => item.id === thread.projectId);
      return kind && project ? [{ thread, project, kind }] : [];
    })
    .sort((a, b) => priority[a.kind] - priority[b.kind]);
  if (!items.length && !store.activityError) return null;
  return (
    <section aria-label="Attention inbox" className="shrink-0 border-b text-xs">
      <div className="flex items-center justify-between px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        <span>Attention</span>
        <span aria-label={`${items.length} items`}>{items.length}</span>
      </div>
      {store.activityError && (
        <p
          role="status"
          className="px-3 pb-2 text-[10px] text-muted-foreground"
        >
          Updates unavailable · showing last known activity
        </p>
      )}
      {items.length > 0 && (
        <ul className="max-h-60 overflow-y-auto px-1 pb-1">
          {items.map(({ thread, project, kind }) => (
            <li key={thread.id}>
              <button
                type="button"
                onClick={() => onSelect(thread)}
                className="w-full rounded-sm px-2 py-2 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                aria-label={`${project.name} / ${thread.name}: ${kind === "approval" ? "waiting for user" : kind === "failure" ? "failed" : "finished"}`}
              >
                <span className="block truncate text-[10px] text-muted-foreground">
                  {project.name}
                </span>
                <span className="block truncate pb-1" title={thread.name}>
                  {thread.name}
                </span>
                <ActivityBadge
                  label={
                    kind === "approval"
                      ? "waiting for user"
                      : kind === "failure"
                        ? "failed"
                        : "finished"
                  }
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
