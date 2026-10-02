import type { SourcePosition, TextSelection } from "./repository-viewer";

/** Read endpoints inside Pierre's shadow tree, never document-rescoped host ranges. */
export function sourceSelection(root: ShadowRoot): TextSelection | undefined {
  const selection = root.ownerDocument.getSelection();
  if (!selection) return;
  const composed = selection as Selection & {
    getComposedRanges?: (options: {
      shadowRoots: ShadowRoot[];
    }) => StaticRange[];
  };
  const local = root as ShadowRoot & { getSelection?: () => Selection | null };
  const fallback = local.getSelection?.() ?? selection;
  const range = composed.getComposedRanges
    ? composed.getComposedRanges({ shadowRoots: [root] })[0]
    : fallback.rangeCount
      ? fallback.getRangeAt(0)
      : undefined;
  if (!range || range.collapsed) return;

  function position(node: Node, offset: number): SourcePosition | undefined {
    if (node.getRootNode() !== root) return;
    const element =
      node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node.parentElement;
    const line = element?.closest<HTMLElement>("[data-line]");
    if (!line || !line.closest("[data-content]")) return;
    const prefix = root.ownerDocument.createRange();
    prefix.setStart(line, 0);
    prefix.setEnd(node, offset);
    return {
      line: Number(line.dataset.line),
      column: prefix.toString().length,
    };
  }
  const start = position(range.startContainer, range.startOffset);
  const end = position(range.endContainer, range.endOffset);
  if (start && end) return { start, end };
}
