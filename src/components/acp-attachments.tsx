"use client";

import { useEffect, useRef, useState } from "react";
import { FileText, Paperclip, X } from "lucide-react";
import type { AcpContent, AcpSnapshot } from "@/lib/acp";
import { attachmentLimit, encodedBytes, mediaUrl } from "@/lib/acp-content";
import { repositoryContextLabel } from "@/lib/repository-context";

function base64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read attachment."));
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.readAsDataURL(file);
  });
}

export function AcpAttachments({
  attachments,
  capabilities,
  disabled,
  onChange,
  onReadingChange,
}: {
  attachments: AcpContent[];
  capabilities: AcpSnapshot["promptCapabilities"];
  disabled: boolean;
  onChange: (attachments: AcpContent[]) => void;
  onReadingChange: (reading: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      onReadingChange(false);
    };
  }, [onReadingChange]);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const supported =
    capabilities?.image || capabilities?.audio || capabilities?.embeddedContext;
  const accept = capabilities?.embeddedContext
    ? undefined
    : [
        capabilities?.image &&
          "image/png,image/jpeg,image/gif,image/webp,image/avif",
        capabilities?.audio && "audio/*",
      ]
        .filter(Boolean)
        .join(",");

  async function attach(files: File[]) {
    setError("");
    setReading(true);
    onReadingChange(true);
    try {
      if (attachments.length + files.length > 4)
        throw new Error("Attach up to four files.");
      const next = [...attachments];
      for (const file of files) {
        if (file.size > 1_400_000)
          throw new Error("Attachments must fit within 1.4 MB total.");
        const uri = `attachment:///${encodeURIComponent(file.name)}`;
        if (file.type.startsWith("image/") || file.type.startsWith("audio/")) {
          const type = file.type.startsWith("image/") ? "image" : "audio";
          const data = await base64(file);
          if (capabilities?.[type] && mediaUrl(type, file.type, data))
            next.push({ type, data, mimeType: file.type, uri });
          else if (capabilities?.embeddedContext)
            next.push({
              type: "resource",
              resource: { uri, mimeType: file.type, blob: data },
            });
          else throw new Error("This agent does not support that media type.");
        } else if (capabilities?.embeddedContext) {
          const mimeType = file.type || "application/octet-stream";
          if (
            file.type.startsWith("text/") ||
            /\.(md|txt|json|csv|js|jsx|ts|tsx|py|css|html|yaml|yml|xml|sh|sql)$/i.test(
              file.name,
            )
          ) {
            const text = await file.text();
            if (text.length > 64000)
              throw new Error(
                "Text attachments must be under 64,000 characters.",
              );
            next.push({ type: "resource", resource: { uri, mimeType, text } });
          } else
            next.push({
              type: "resource",
              resource: { uri, mimeType, blob: await base64(file) },
            });
        } else
          throw new Error("This agent does not support that attachment type.");
      }
      if (encodedBytes(next) > attachmentLimit)
        throw new Error("Attachments must fit within 1.4 MB total.");
      if (!mounted.current) return;
      onChange(next);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not read attachment.",
      );
    } finally {
      setReading(false);
      if (mounted.current) onReadingChange(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="mx-auto mb-2 w-full max-w-3xl">
      <div className="flex flex-wrap items-center gap-2">
        {supported && (
          <>
            <input
              ref={input}
              type="file"
              multiple
              accept={accept}
              className="hidden"
              aria-label="Choose attachments"
              disabled={disabled || reading}
              onChange={(event) =>
                void attach(Array.from(event.target.files ?? []))
              }
            />
            <button
              type="button"
              disabled={disabled || reading || attachments.length >= 4}
              onClick={() => input.current?.click()}
              className="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
            >
              <Paperclip className="size-3" aria-hidden="true" />
              {reading ? "Reading…" : "Attach"}
            </button>
          </>
        )}
        {attachments.map((block, index) => {
          const contextLabel = repositoryContextLabel(block);
          const label =
            contextLabel ??
            (block.type === "resource"
              ? decodeURIComponent(
                  block.resource.uri.split("/").at(-1) ?? "Resource",
                )
              : block.type === "image" && block.uri
                ? decodeURIComponent(block.uri.split("/").at(-1) ?? "Image")
                : block.type);
          return (
            <span
              key={index}
              className="flex max-w-full items-center gap-2 rounded-md border bg-background px-2 py-1 text-[11px]"
            >
              {contextLabel && (
                <FileText className="size-3 shrink-0" aria-hidden="true" />
              )}
              <span className="truncate" title={label}>
                {label}
              </span>
              <button
                type="button"
                aria-label={`Remove ${label}`}
                disabled={disabled || reading}
                onClick={() =>
                  onChange(
                    attachments.filter((_, position) => position !== index),
                  )
                }
                className="text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </span>
          );
        })}
      </div>
      {error && (
        <p role="alert" className="mt-1 text-[11px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
