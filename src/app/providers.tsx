"use client";

import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";
import { ToastProvider } from "@/components/ui/toast";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      storageKey="agentflare-theme"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <ToastProvider>{children}</ToastProvider>
    </ThemeProvider>
  );
}
