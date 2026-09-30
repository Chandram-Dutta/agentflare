// Keep rich payloads bounded separately from the existing text transcript budget.
export const contentLimit = 2_000_000;
export const transcriptContentLimit = 8_000_000;

export function retainContent(block) {
  if (
    !block ||
    !["text", "image", "audio", "resource", "resource_link"].includes(
      block.type,
    )
  )
    return { type: "text", text: "Unsupported content." };
  if (JSON.stringify(block).length > contentLimit)
    return {
      type: "text",
      text: "Content omitted: attachment exceeds the size limit.",
    };
  return structuredClone(block);
}

export function boundContent(snapshot) {
  let size = snapshot.messages.reduce(
    (sum, message) => sum + JSON.stringify(message.content ?? []).length,
    0,
  );
  for (const message of snapshot.messages) {
    if (size <= transcriptContentLimit) break;
    if (!message.content) continue;
    size -= JSON.stringify(message.content).length;
    message.content = [{ type: "text", text: "Earlier attachment omitted." }];
    size += JSON.stringify(message.content).length;
    snapshot.truncated = true;
  }
}

export function promptContent(action, capabilities = {}) {
  const attachments = action.attachments ?? [];
  if (
    !Array.isArray(attachments) ||
    attachments.length > 4 ||
    JSON.stringify(attachments).length > contentLimit
  )
    throw new Error("Attachments exceed the size limit");
  for (const block of attachments) {
    const supported =
      block.type === "image"
        ? capabilities.image
        : block.type === "audio"
          ? capabilities.audio
          : block.type === "resource"
            ? capabilities.embeddedContext
            : block.type === "text" || block.type === "resource_link";
    if (!supported)
      throw new Error("Attachment type is unavailable for this agent");
  }
  return [
    ...(action.text.trim() ? [{ type: "text", text: action.text }] : []),
    ...attachments,
  ];
}
