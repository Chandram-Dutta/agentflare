// Keep rich payloads bounded separately from the existing text transcript budget.
export const contentLimit = 2_000_000;
export const transcriptContentLimit = 8_000_000;
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

export function retainContent(block) {
  if (
    !block ||
    !["text", "image", "audio", "resource", "resource_link"].includes(
      block.type,
    )
  )
    return { type: "text", text: "Unsupported content." };
  if (bytes(block) > contentLimit)
    return {
      type: "text",
      text: "Content omitted: attachment exceeds the size limit.",
    };
  return structuredClone(block);
}

// Adjacent text chunks are one Markdown document, not individual paragraphs.
export function appendContent(message, block) {
  message.content ??= [];
  const next = retainContent(block);
  const previous = message.content.at(-1);
  if (next.type === "text" && previous?.type === "text") {
    const text = previous.text + next.text;
    previous.text = text.slice(0, 64000);
    return text.length > 64000;
  }
  message.content.push(next);
  return false;
}

export function boundContent(snapshot) {
  let size = snapshot.messages.reduce(
    (sum, message) => sum + bytes(message.content ?? []),
    0,
  );
  for (const message of snapshot.messages) {
    if (size <= transcriptContentLimit) break;
    if (!message.content) continue;
    size -= bytes(message.content);
    message.content = [{ type: "text", text: "Earlier attachment omitted." }];
    size += bytes(message.content);
    snapshot.truncated = true;
  }
}

export function promptContent(action, capabilities = {}) {
  const attachments = action.attachments ?? [];
  if (
    !Array.isArray(attachments) ||
    attachments.length > 4 ||
    bytes(attachments) > contentLimit
  )
    throw new Error("Attachments exceed the size limit");
  for (const block of attachments) {
    if (
      (block.type === "resource" && !capabilities.embeddedContext) ||
      (!["text", "resource_link", "resource", "image", "audio"].includes(block.type))
    )
      throw new Error("Attachment type is unavailable for this agent");
  }
  const result = [
    ...(action.text.trim() ? [{ type: "text", text: action.text }] : []),
    ...attachments.map((block) => {
      if (
        (block.type === "image" && !capabilities.image) ||
        (block.type === "audio" && !capabilities.audio)
      ) {
        if (!capabilities.embeddedContext)
          throw new Error("Attachment type is unavailable for this agent");
        return {
          type: "resource",
          resource: {
            uri: block.uri ?? `attachment:///${block.type}`,
            mimeType: block.mimeType,
            blob: block.data,
          },
        };
      }
      return block;
    }),
  ];
  if (bytes(result) > contentLimit)
    throw new Error("Prompt exceeds the size limit");
  return result;
}
