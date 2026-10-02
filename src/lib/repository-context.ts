import type { AcpContent, AcpSnapshot } from "./acp";
import { attachmentLimit, attachmentSchema, encodedBytes } from "./acp-content";

export const REPOSITORY_CONTEXT_LIMIT = 64000;

export type RepositoryContext = {
  kind: "file" | "selection" | "diff";
  path: string;
  content: string;
  startLine?: number;
  endLine?: number;
};

function contextUri(
  input:
    | Omit<RepositoryContext, "content">
    | { kind: "reference"; path: string },
) {
  const { path, kind } = input;
  if (
    !path ||
    path.startsWith("/") ||
    /[\x00-\x1f\x7f\\]/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Context requires a repository-relative file path.");
  const start = "startLine" in input ? input.startLine : undefined;
  const end = "endLine" in input ? input.endLine : undefined;
  if (
    (start !== undefined && (!Number.isSafeInteger(start) || start < 1)) ||
    (end !== undefined &&
      (!Number.isSafeInteger(end) || start === undefined || end < start)) ||
    (kind === "selection" && start === undefined)
  )
    throw new Error("Context requires a valid, one-based line range.");
  return `repository:///${path.split("/").map(encodeURIComponent).join("/")}?kind=${kind}${start === undefined ? "" : `#L${start}${end === undefined ? "" : `-L${end}`}`}`;
}

function resource(uri: string, text: string): AcpContent {
  if (text.length > REPOSITORY_CONTEXT_LIMIT)
    throw new Error(
      "Context must be at most 64,000 characters; select a smaller range.",
    );
  if (uri.length > 2048) throw new Error("Context path is too long.");
  return { type: "resource", resource: { uri, mimeType: "text/plain", text } };
}

/** Content is preserved exactly. The URI records kind, repository path and lines. */
export function createRepositoryContext(input: RepositoryContext): AcpContent {
  return resource(contextUri(input), input.content);
}

/** References deliberately contain no file snapshot; the agent reads its workspace. */
export function createRepositoryReference(path: string): AcpContent {
  return resource(
    contextUri({ kind: "reference", path }),
    `Repository file reference: ${JSON.stringify(path)}\nRead this file from the current repository workspace. This attachment is a reference, not a content snapshot.`,
  );
}

export function repositoryContextLabel(block: AcpContent): string | undefined {
  if (
    block.type !== "resource" ||
    !block.resource.uri.startsWith("repository:///")
  )
    return;
  try {
    const url = new URL(block.resource.uri);
    const path = decodeURIComponent(url.pathname.slice(1));
    const lines = url.hash.replace(/^#L/, ":").replace("-L", "–");
    return `${path}${lines} · ${url.searchParams.get("kind") ?? "file"}`;
  } catch {
    return;
  }
}

/** Pure append: callers must pass the latest draft/attachments and catch errors for UI. */
export function appendRepositoryContext(
  attachments: AcpContent[] | undefined,
  context: AcpContent,
  capabilities: AcpSnapshot["promptCapabilities"],
  draft = "",
): AcpContent[] {
  if (!capabilities?.embeddedContext)
    throw new Error("This agent does not support embedded repository context.");
  if (
    context.type !== "resource" ||
    !attachmentSchema.safeParse(context).success
  )
    throw new Error("Invalid repository context attachment.");
  const next = [...(attachments ?? []), context];
  if (next.length > 4)
    throw new Error("Attach up to four files or context items.");
  if (
    encodedBytes([
      ...(draft.trim() ? [{ type: "text", text: draft.trim() }] : []),
      ...next,
    ]) > attachmentLimit
  )
    throw new Error("Attachments and message exceed the encoded size limit.");
  return next;
}

export function activeMention(text: string, caret: number) {
  const match = /(?:^|\s)@([^@\n\r]*)$/.exec(text.slice(0, caret));
  if (!match) return;
  return { start: caret - match[1].length - 1, end: caret, query: match[1] };
}
