"use client";

import { Toast } from "@base-ui/react/toast";
import { Check, CircleAlert, LoaderCircle, X } from "lucide-react";
import type { ReactNode } from "react";

export const toast = Toast.createToastManager();

export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider toastManager={toast} timeout={5000} limit={3}>
      {children}
      <ToastList />
    </Toast.Provider>
  );
}

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return (
    <Toast.Portal>
      <Toast.Viewport className="fixed right-3 top-14 z-[100] flex w-[min(24rem,calc(100vw-1.5rem))] flex-col gap-2 outline-none sm:top-auto sm:bottom-3">
        {toasts.map((item) => {
          const Icon =
            item.type === "loading"
              ? LoaderCircle
              : item.type === "error"
                ? CircleAlert
                : Check;
          return (
            <Toast.Root
              key={item.id}
              toast={item}
              className="rounded-lg border bg-background p-3 text-xs text-foreground shadow-lg data-limited:hidden data-ending-style:hidden"
            >
              <Toast.Content className="flex items-start gap-2">
                <Icon
                  aria-hidden="true"
                  className={`mt-0.5 size-3.5 shrink-0 ${item.type === "loading" ? "motion-safe:animate-spin" : item.type === "error" ? "text-destructive" : "text-muted-foreground"}`}
                />
                <div className="min-w-0 flex-1 break-words">
                  <Toast.Title className="leading-5" />
                  <Toast.Description className="mt-1 text-muted-foreground" />
                </div>
                <Toast.Close
                  aria-label="Dismiss notification"
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <X className="size-3.5" />
                </Toast.Close>
              </Toast.Content>
            </Toast.Root>
          );
        })}
      </Toast.Viewport>
    </Toast.Portal>
  );
}
