"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Bell, BellRing } from "lucide-react";
import { useThreadStore } from "./thread-state";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "./ui/dialog";

export function NotificationSettings({ userId }: { userId: string }) {
  const store = useThreadStore();
  const enabled = useSyncExternalStore(
    store.subscribe,
    () => store.notificationsEnabled,
    () => false,
  );
  const [open, setOpen] = useState(false);
  const [permission, setPermission] = useState<
    NotificationPermission | "unavailable"
  >("unavailable");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const key = `agentflare-notifications-${userId}`;

  useEffect(() => {
    function refresh() {
      const permission =
        "Notification" in window && window.isSecureContext
          ? Notification.permission
          : "unavailable";
      setPermission(permission);
      let optedIn = store.notificationsEnabled;
      try {
        optedIn = localStorage.getItem(key) === "enabled";
      } catch {
        // The toggle still works for this session if storage is unavailable.
      }
      store.setNotificationsEnabled(optedIn && permission === "granted");
    }
    refresh();
    const storage = (event: StorageEvent) => {
      if (event.key === key || event.key === null) refresh();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", storage);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", storage);
      store.setNotificationsEnabled(false);
    };
  }, [store, key]);

  function save(enabled: boolean) {
    store.setNotificationsEnabled(enabled);
    try {
      localStorage.setItem(key, enabled ? "enabled" : "disabled");
    } catch {
      // Only a preference is stored; conversations stay in the workspace store.
    }
  }

  async function toggle() {
    setError("");
    if (enabled) {
      save(false);
      return;
    }
    if (!("Notification" in window) || !window.isSecureContext) return;
    setPending(true);
    try {
      const result =
        Notification.permission === "granted"
          ? "granted"
          : await Notification.requestPermission();
      setPermission(result);
      save(result === "granted");
      if (result === "default")
        setError(
          "Permission wasn't granted. Try enabling notifications again.",
        );
    } catch {
      setError("This browser couldn't enable desktop notifications.");
    } finally {
      setPending(false);
    }
  }

  const Icon = enabled ? BellRing : Bell;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Notification settings"
        title={enabled ? "Notifications enabled" : "Notification settings"}
        onClick={() => setOpen(true)}
        className={enabled ? "text-primary" : undefined}
      >
        <Icon className="size-4" aria-hidden="true" />
      </Button>
      <DialogContent>
        <DialogTitle>Desktop notifications</DialogTitle>
        <DialogDescription>
          Get notified when Codex finishes a turn or needs an approval or
          sign-in while this tab is in the background. Click a notification to
          open its thread. Keep the workspace tab open to receive notifications.
        </DialogDescription>
        <p role="status" className="text-xs text-muted-foreground">
          {permission === "unavailable"
            ? "Desktop notifications aren't available in this browser. Use a supported browser over HTTPS or localhost."
            : permission === "denied"
              ? "Notifications are blocked. Allow them in your browser's site settings, then return to this tab."
              : enabled
                ? "Notifications are enabled for this account in this browser."
                : "Notifications are off."}
        </p>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            close
          </Button>
          <Button
            disabled={
              pending || permission === "unavailable" || permission === "denied"
            }
            onClick={() => void toggle()}
          >
            {pending
              ? "enabling…"
              : enabled
                ? "turn off notifications"
                : "enable notifications"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
