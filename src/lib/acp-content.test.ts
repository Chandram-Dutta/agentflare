import { expect, test } from "bun:test";
import type { AcpContent } from "./acp";
import {
  encodedBytes,
  mediaUrl,
  promptActionSchema,
  resourceUrl,
} from "./acp-content";
import {
  appendContent,
  boundContent,
  promptContent,
  retainContent,
} from "../../sandbox/acp/content.mjs";

test("rich prompt validation permits attachment-only sends and rejects malformed payloads", () => {
  const prompt = {
    type: "prompt",
    text: "",
    requestId: "one",
    attachments: [
      {
        type: "image",
        mimeType: "image/png",
        uri: "attachment:///image.png",
        data: "aGk=",
      },
    ],
  };
  expect(promptActionSchema.safeParse(prompt).success).toBe(true);
  expect(
    promptActionSchema.safeParse({ ...prompt, attachments: [] }).success,
  ).toBe(false);
  expect(
    promptActionSchema.safeParse({
      ...prompt,
      attachments: [{ ...prompt.attachments[0], data: "not base64" }],
    }).success,
  ).toBe(false);
  expect(
    promptActionSchema.safeParse({
      ...prompt,
      attachments: Array(5).fill(prompt.attachments[0]),
    }).success,
  ).toBe(false);
  expect(() => promptContent(prompt, {})).toThrow("unavailable");
  expect(promptContent(prompt, { image: true })).toEqual(prompt.attachments);
});

test("resource links and media previews reject executable URLs and formats", () => {
  for (const uri of [
    "javascript:alert(1)",
    "data:text/html,hi",
    "file:///tmp/file",
    "https://user:pass@example.com",
  ])
    expect(resourceUrl(uri)).toBeUndefined();
  expect(resourceUrl("https://example.com/file")).toBe(
    "https://example.com/file",
  );
  expect(mediaUrl("image", "image/svg+xml", "aGk=")).toBeUndefined();
  expect(mediaUrl("image", "image/png", "aGk=")).toBe(
    "data:image/png;base64,aGk=",
  );
});

test("rich transcript budgets retain recent content and visibly omit oversized blocks", () => {
  expect(
    retainContent({ type: "image", data: "a".repeat(2_000_001) }).type,
  ).toBe("text");
  const snapshot = {
    messages: Array.from({ length: 6 }, () => ({
      content: [{ type: "image", data: "a".repeat(1_900_000) }],
    })),
    truncated: false,
  };
  boundContent(snapshot);
  expect(snapshot.truncated).toBe(true);
  expect(
    encodedBytes(snapshot.messages.flatMap((message) => message.content ?? [])),
  ).toBeLessThan(8_000_000);
  expect(snapshot.messages.at(-1)?.content[0].type).toBe("image");
});

test("rich budgets count UTF-8 bytes and include prompt text", () => {
  const multibyte = { type: "text", text: "😀".repeat(500_000) };
  expect(encodedBytes(multibyte)).toBeGreaterThan(2_000_000);
  expect(retainContent(multibyte).text).toContain("omitted");
  expect(
    promptActionSchema.safeParse({
      type: "prompt",
      text: "😀".repeat(8_000),
      requestId: "utf8",
      attachments: [
        { type: "image", mimeType: "image/png", data: "A".repeat(1_980_000) },
      ],
    }).success,
  ).toBe(false);
  expect(
    promptActionSchema.safeParse({
      type: "prompt",
      text: "a".repeat(16_000),
      requestId: "ascii",
      attachments: [
        { type: "image", mimeType: "image/png", data: "A".repeat(1_980_000) },
      ],
    }).success,
  ).toBe(true);
});

test("unsupported media falls back to embedded context", () => {
  const prompt = {
    type: "prompt",
    text: "",
    requestId: "fallback",
    attachments: [{ type: "image", mimeType: "image/png", data: "aGk=" }],
  };
  expect(promptContent(prompt, { embeddedContext: true })).toEqual([
    {
      type: "resource",
      resource: {
        uri: "attachment:///image",
        mimeType: "image/png",
        blob: "aGk=",
      },
    },
  ]);
});

test("streamed Markdown joins adjacent text without moving text across images", () => {
  const message: { content: AcpContent[] } = {
    content: [],
  };
  for (const text of ["**bo", "ld**"])
    appendContent(message, { type: "text", text });
  appendContent(message, {
    type: "image",
    mimeType: "image/png",
    data: "aGk=",
  });
  for (const text of ["[read", "me](README.md:12)"])
    appendContent(message, { type: "text", text });
  expect(message.content).toEqual([
    { type: "text", text: "**bold**" },
    { type: "image", mimeType: "image/png", data: "aGk=" },
    { type: "text", text: "[readme](README.md:12)" },
  ]);
});
