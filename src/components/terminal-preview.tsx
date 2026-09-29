"use client";

import { useEffect, useRef, useState } from "react";
import type { Terminal } from "ghostty-web";

export function TerminalPreview() {
  const container = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Loading Ghostty renderer…");
  const [dimensions, setDimensions] = useState("");
  const [input, setInput] = useState(
    "Click the terminal and type to test keyboard input.",
  );

  useEffect(() => {
    let cancelled = false;
    let terminal: Terminal | undefined;

    async function open() {
      const { Ghostty, Terminal, FitAddon } = await import("ghostty-web");
      const ghostty = await Ghostty.load("/ghostty-vt.wasm");
      if (cancelled || !container.current) return;
      terminal = new Terminal({
        ghostty,
        fontSize: 13,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        cursorBlink: false,
        theme: {
          background: "#151619",
          foreground: "#c9ccd2",
          cursor: "#ff9257",
          brightBlack: "#9298a3",
        },
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(container.current);
      const sample = [
        "\x1b[38;2;255;146;87mAGENTFLARE\x1b[0m  /  terminal renderer preview",
        "",
        "Your agent's own UI belongs here.",
        "No chat wrapper. No translated tool calls.",
        "",
        "\x1b[90m──────────────────────────────────────────────\x1b[0m",
        "",
        "\x1b[32m✓\x1b[0m Ghostty WASM loaded locally",
        "\x1b[32m✓\x1b[0m ANSI colors and cursor control available",
        "\x1b[33m○\x1b[0m Cloudflare sandbox not connected",
        "\x1b[33m○\x1b[0m No CLI agent running",
        "",
        "\x1b[90mThis is sample output, not an agent session.\x1b[0m",
        "\x1b[?25l",
      ].join("\r\n");
      // This preview has no PTY to redraw after SIGWINCH. Redraw its sample only;
      // a live terminal must forward dimensions instead of replacing its output.
      const redraw = () => terminal?.write(`\x1b[2J\x1b[H${sample}`);
      terminal.onResize(({ cols, rows }) => {
        setDimensions(`${cols} × ${rows}`);
        redraw();
      });
      fit.fit();
      fit.observeResize();
      setDimensions(`${terminal.cols} × ${terminal.rows}`);
      terminal.onData((data) =>
        setInput(
          `Input received: ${JSON.stringify(data)} · not sent to a shell`,
        ),
      );
      redraw();
      setStatus("Renderer ready");
    }

    void open().catch(() => {
      terminal?.dispose();
      if (!cancelled) setStatus("Terminal failed to load. Reload to retry.");
    });
    return () => {
      cancelled = true;
      terminal?.dispose();
    };
  }, []);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div
        className="min-h-80 flex-1 overflow-hidden p-5"
        aria-label="Ghostty terminal renderer preview"
      >
        <div ref={container} className="h-[390px] w-full overflow-hidden" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-5 py-3 font-mono text-[11px] text-muted-foreground">
        <span role="status">
          {status} {dimensions && `· ${dimensions}`}
        </span>
        <span className="max-w-full break-all" aria-live="polite">
          {input}
        </span>
      </div>
    </div>
  );
}
