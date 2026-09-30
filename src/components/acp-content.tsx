import type { AcpContent as ContentBlock } from "@/lib/acp";
import { mediaUrl, resourceUrl } from "@/lib/acp-content";
import { ChatMarkdown } from "./chat-markdown";

const resourceClass = "min-w-0 border bg-background/30 p-3";

function ResourceLabel({ uri, name }: { uri: string; name: string }) {
  const href = resourceUrl(uri);
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="break-all underline underline-offset-2"
    >
      {name}
    </a>
  ) : (
    <span className="break-all">{name}</span>
  );
}

export function AcpContent({
  blocks,
  literal = false,
}: {
  blocks: ContentBlock[];
  literal?: boolean;
}) {
  return (
    <div className="space-y-3">
      {blocks.map((block, index) => {
        if (block.type === "text")
          return literal ? (
            <pre
              key={index}
              className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-muted-foreground"
            >
              {block.text}
            </pre>
          ) : (
            <ChatMarkdown key={index}>{block.text}</ChatMarkdown>
          );
        if (block.type === "image" || block.type === "audio") {
          const src = mediaUrl(block.type, block.mimeType, block.data);
          return (
            <figure key={index} className={resourceClass}>
              {src ? (
                block.type === "image" ? (
                  // ACP images are inline data, rather than optimizable remote assets.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={src}
                    alt="Conversation attachment"
                    loading="lazy"
                    className="max-h-96 max-w-full object-contain"
                  />
                ) : (
                  <audio
                    controls
                    preload="none"
                    src={src}
                    aria-label="Conversation audio attachment"
                    className="w-full"
                  />
                )
              ) : (
                <p className="text-muted-foreground">
                  Preview unavailable · {block.mimeType}
                </p>
              )}
              <figcaption className="mt-2 text-[10px] text-muted-foreground">
                {block.type} · {block.mimeType}
              </figcaption>
            </figure>
          );
        }
        if (block.type === "resource_link")
          return (
            <div key={index} className={resourceClass}>
              <ResourceLabel uri={block.uri} name={block.title ?? block.name} />
              {block.description && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {block.description}
                </p>
              )}
              <p className="mt-1 break-all text-[10px] text-muted-foreground">
                {block.uri}
              </p>
            </div>
          );
        const resource = block.resource;
        return (
          <details key={index} className={resourceClass}>
            <summary className="cursor-pointer break-all text-[11px]">
              {resource.uri}
            </summary>
            {"text" in resource ? (
              <pre
                tabIndex={0}
                className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-muted-foreground"
              >
                {resource.text}
              </pre>
            ) : (
              <a
                href={`data:application/octet-stream;base64,${resource.blob}`}
                download="resource"
                className="mt-2 inline-block text-[11px] text-muted-foreground underline underline-offset-2"
              >
                Download resource · {resource.mimeType ?? "unknown format"}
              </a>
            )}
          </details>
        );
      })}
    </div>
  );
}
