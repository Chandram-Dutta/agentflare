import { expect, test } from "bun:test";
import { mediaUrl, promptActionSchema, resourceUrl } from "./acp-content";
import {
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
  expect(JSON.stringify(snapshot).length).toBeLessThan(8_000_000);
  expect(snapshot.messages.at(-1)?.content[0].type).toBe("image");
});
