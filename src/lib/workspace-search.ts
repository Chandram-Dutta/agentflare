import type { AcpMessage } from "./acp";

export function matchesQuery(value: string, query: string) {
  return query
    .toLocaleLowerCase()
    .trim()
    .split(/\s+/)
    .every((word) => value.toLocaleLowerCase().includes(word));
}
export function searchConversation(messages: AcpMessage[], query: string) {
  return query.trim()
    ? messages.filter((message) => matchesQuery(message.text, query))
    : [];
}
export function searchLines(path: string, content: string, query: string) {
  return content
    .split("\n")
    .flatMap((text, index) =>
      matchesQuery(text, query) ? [{ path, startLine: index + 1, text }] : [],
    )
    .slice(0, 20);
}
export function navigationShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
}) {
  if (event.isComposing || event.altKey || !(event.metaKey || event.ctrlKey))
    return;
  if (event.key.toLowerCase() === "k" && !event.shiftKey) return "switch";
  if (event.key.toLowerCase() === "p" && !event.shiftKey) return "files";
}
