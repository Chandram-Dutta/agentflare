"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import type { Terminal } from "ghostty-web";

export function TerminalPreview({ threadId }: { threadId: string }) {
  const container = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();
  const [status, setStatus] = useState("loading terminal");
  const [dimensions, setDimensions] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!resolvedTheme) return;
    let cancelled = false;
    let terminal: Terminal | undefined;
    let observer: ResizeObserver | undefined;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let socket: WebSocket | undefined;

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
      terminal.onResize(({ cols, rows }) => {
        setDimensions(`${cols} × ${rows}`);
        if (socket?.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify({ type: "resize", cols, rows }));
      });
      fit.fit();
      // FitAddon.observeResize drops notifications during its 50ms resize lock.
      // Queue every notification so a quick tab switch + resize isn't lost.
      observer = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => fit.fit(), 100);
      });
      observer.observe(container.current);
      setDimensions(`${terminal.cols} × ${terminal.rows}`);
      const url = new URL(
        `/api/threads/${threadId}/runtime/terminal`,
        window.location.href,
      );
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("cols", String(terminal.cols));
      url.searchParams.set("rows", String(terminal.rows));
      socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      setStatus("connecting…");
      const encoder = new TextEncoder();
      terminal.onData((data) => {
        if (socket?.readyState === WebSocket.OPEN)
          socket.send(encoder.encode(data));
      });
      socket.onmessage = (event) => {
        if (cancelled) return;
        if (event.data instanceof ArrayBuffer)
          terminal?.write(new Uint8Array(event.data));
        else {
          const message = JSON.parse(event.data);
          if (message.type === "ready") setStatus("connected");
          if (message.type === "exit")
            setStatus(`agent exited (${message.exitCode ?? "unknown"})`);
          if (message.type === "error")
            setStatus("terminal error — reconnect to retry");
        }
      };
      socket.onclose = () => {
        if (!cancelled) setStatus("disconnected — reconnect to retry");
      };
      socket.onerror = () => {
        if (!cancelled)
          setStatus("connection failed — check sandbox and sign-in");
      };
    }

    void open().catch(() => {
      terminal?.dispose();
      if (!cancelled) setStatus("terminal unavailable — reload to retry");
    });
    return () => {
      cancelled = true;
      observer?.disconnect();
      clearTimeout(resizeTimer);
      socket?.close();
      terminal?.dispose();
    };
  }, [resolvedTheme, threadId, attempt]);

  return (
    <>
      <div className="relative flex min-h-[320px] flex-1 flex-col bg-[var(--terminal)] p-4 sm:p-6">
        <div
          ref={container}
          data-terminal-host
          className="absolute inset-4 overflow-hidden caret-transparent outline-none sm:inset-6"
        />
      </div>
      <footer className="flex min-h-9 flex-wrap items-center justify-between gap-2 border-t px-4 py-2 text-[11px] text-muted-foreground sm:px-6">
        <span role="status">{status}</span>
        <button
          type="button"
          className="underline underline-offset-4"
          onClick={() => setAttempt((value) => value + 1)}
        >
          reconnect
        </button>
        <span data-terminal-size>{dimensions}</span>
      </footer>
    </>
  );
}
