"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import type { Terminal } from "ghostty-web";

export function TerminalPreview() {
  const container = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();
  const [status, setStatus] = useState("loading terminal");
  const [dimensions, setDimensions] = useState("");

  useEffect(() => {
    if (!resolvedTheme) return;
    let cancelled = false;
    let terminal: Terminal | undefined;
    let observer: ResizeObserver | undefined;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;

    async function open() {
      const { Ghostty, Terminal, FitAddon } = await import("ghostty-web");
      const ghostty = await Ghostty.load("/ghostty-vt.wasm");
      if (cancelled || !container.current) return;
      const style = getComputedStyle(container.current);
      terminal = new Terminal({
        ghostty,
        fontSize: 13,
        fontFamily:
          "ui-monospace, SFMono-Regular, Consolas, Liberation Mono, monospace",
        cursorBlink: false,
        theme: {
          background: style.getPropertyValue("--terminal").trim(),
          foreground: style.getPropertyValue("--foreground").trim(),
          cursor: style.getPropertyValue("--primary").trim(),
        },
      });
      const fit = new FitAddon();
      const previousFocus = document.activeElement;
      terminal.loadAddon(fit);
      terminal.open(container.current);
      // Ghostty focuses its editable host on open. Do not steal focus from setup
      // controls when loading WASM or switching themes.
      if (
        previousFocus instanceof HTMLElement &&
        previousFocus !== document.body
      ) {
        previousFocus.focus({ preventScroll: true });
      } else {
        container.current.blur();
      }
      terminal.write("\x1b[?25l");
      terminal.onResize(({ cols, rows }) => setDimensions(`${cols} × ${rows}`));
      fit.fit();
      // FitAddon.observeResize drops notifications during its 50ms resize lock.
      // Queue every notification so a quick tab switch + resize isn't lost.
      observer = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => fit.fit(), 100);
      });
      observer.observe(container.current);
      setDimensions(`${terminal.cols} × ${terminal.rows}`);
      terminal.onData(() => setStatus("no session — input not sent"));
      setStatus("no session");
    }

    void open().catch(() => {
      terminal?.dispose();
      if (!cancelled) setStatus("terminal unavailable — reload to retry");
    });
    return () => {
      cancelled = true;
      observer?.disconnect();
      clearTimeout(resizeTimer);
      terminal?.dispose();
    };
  }, [resolvedTheme]);

  return (
    <>
      <div className="relative flex min-h-[320px] flex-1 flex-col bg-[var(--terminal)] p-4 sm:p-6">
        <p className="pointer-events-none absolute top-5 left-4 z-10 text-xs text-muted-foreground sm:left-6">
          No workspace connected.
        </p>
        <div
          ref={container}
          data-terminal-host
          className="absolute inset-4 overflow-hidden caret-transparent outline-none sm:inset-6"
        />
      </div>
      <footer className="flex min-h-9 flex-wrap items-center justify-between gap-2 border-t px-4 py-2 text-[11px] text-muted-foreground sm:px-6">
        <span role="status">{status}</span>
        <span data-terminal-size>{dimensions}</span>
      </footer>
    </>
  );
}
