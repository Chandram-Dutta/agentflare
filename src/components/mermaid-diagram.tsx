"use client";

import { useEffect, useId, useRef, useState } from "react";

type RenderedDiagram = {
  source: string;
  theme: "default" | "dark";
  svg?: string;
  failed?: boolean;
  bindFunctions?: (element: Element) => void;
};

function currentTheme(): RenderedDiagram["theme"] {
  return document.documentElement.classList.contains("dark")
    ? "dark"
    : "default";
}

export function MermaidDiagram({ source }: { source: string }) {
  const reactId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState<RenderedDiagram["theme"]>();
  const [rendered, setRendered] = useState<RenderedDiagram>();

  useEffect(() => {
    const updateTheme = () => setTheme(currentTheme());
    updateTheme();
    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!theme) return;
    let active = true;
    const id = `mermaid-${reactId.replaceAll(":", "")}-${theme}`;

    void (async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        if (!active) return;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme,
        });
        const result = await mermaid.render(id, source);
        if (active)
          setRendered({
            source,
            theme,
            svg: result.svg,
            bindFunctions: result.bindFunctions,
          });
      } catch {
        // Mermaid leaves its temporary error diagram attached to <body> when
        // rendering rejects. The source fallback below is the useful error UI.
        document.getElementById(`d${id}`)?.remove();
        if (active) setRendered({ source, theme, failed: true });
      }
    })();

    return () => {
      active = false;
    };
  }, [reactId, source, theme]);

  useEffect(() => {
    if (
      containerRef.current &&
      rendered?.source === source &&
      rendered.theme === theme
    )
      rendered.bindFunctions?.(containerRef.current);
  }, [rendered, source, theme]);

  const svg =
    rendered?.source === source && rendered.theme === theme
      ? rendered.svg
      : undefined;
  const failed =
    rendered?.source === source &&
    rendered.theme === theme &&
    rendered.failed;

  return (
    <figure
      data-mermaid-diagram=""
      className="my-3 min-w-0 overflow-x-auto rounded-sm border bg-muted p-3"
    >
      {svg ? (
        <div
          ref={containerRef}
          className="flex min-w-max justify-center [&_svg]:h-auto [&_svg]:max-w-full"
          // Mermaid renders SVG with its strict security mode enabled.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <pre className="m-0 border-0 bg-transparent p-0">
          <code className="language-mermaid">{source}</code>
        </pre>
      )}
      {failed && (
        <figcaption className="mt-2 text-[10px] text-muted-foreground">
          Unable to render diagram. Showing Mermaid source.
        </figcaption>
      )}
    </figure>
  );
}
