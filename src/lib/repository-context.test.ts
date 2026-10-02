import { expect, test } from "bun:test";
import {
  activeMention,
  appendRepositoryContext,
  createRepositoryContext,
  createRepositoryReference,
  repositoryContextLabel,
} from "./repository-context";
import { promptActionSchema } from "./acp-content";
import { ThreadStateStore } from "./thread-state";
import type { AcpSnapshot } from "./acp";

const capabilities = { embeddedContext: true };
test("context preserves literal content and path/range metadata through ACP serialization", () => {
  const content = "  <tag>\n🙂\ntrailing  ";
  const block = createRepositoryContext({
    kind: "selection",
    path: "src/a b#%.tsx",
    content,
    startLine: 17,
    endLine: 23,
  });
  expect(block).toEqual({
    type: "resource",
    resource: {
      uri: "repository:///src/a%20b%23%25.tsx?kind=selection#L17-L23",
      mimeType: "text/plain",
      text: content,
    },
  });
  expect(repositoryContextLabel(block)).toBe("src/a b#%.tsx:17–23 · selection");
  const parsed = promptActionSchema.parse({
    type: "prompt",
    text: "",
    requestId: "one",
    attachments: [block],
  });
  expect(JSON.stringify(parsed.attachments)).toBe(JSON.stringify([block]));
  expect(createRepositoryReference("a b.ts")).toMatchObject({
    resource: { text: expect.stringContaining('"a b.ts"') },
  });
});

test("rejects invalid ranges and paths, accepts exactly 64000 chars without truncation", () => {
  const input = {
    kind: "file" as const,
    path: "src/a.ts",
    content: "x".repeat(64000),
  };
  expect(createRepositoryContext(input)).toMatchObject({
    resource: { text: input.content },
  });
  expect(() =>
    createRepositoryContext({ ...input, content: input.content + "x" }),
  ).toThrow("64,000");
  for (const path of ["/a", "../a", "a/../b", "a\\b", "a\n", "a//b"])
    expect(() => createRepositoryContext({ ...input, path })).toThrow("path");
  for (const range of [
    { startLine: 0 },
    { startLine: 4, endLine: 3 },
    { endLine: 8 },
    { startLine: 1.5 },
  ])
    expect(() => createRepositoryContext({ ...input, ...range })).toThrow(
      "range",
    );
});

test("append gates capability, count and encoded total including message without mutating inputs", () => {
  const block = createRepositoryReference("a.ts");
  expect(() => appendRepositoryContext([], block, {})).toThrow("support");
  const four = [block, block, block, block];
  expect(
    appendRepositoryContext(four.slice(1), block, capabilities),
  ).toHaveLength(4);
  expect(() => appendRepositoryContext(four, block, capabilities)).toThrow(
    "four",
  );
  expect(four).toHaveLength(4);
  const large = {
    type: "image" as const,
    mimeType: "image/png",
    data: "A".repeat(1_990_000),
  };
  expect(appendRepositoryContext([large], block, capabilities)).toHaveLength(2);
  expect(() =>
    appendRepositoryContext([large], block, capabilities, "🙂".repeat(4000)),
  ).toThrow("encoded");
});

test("mention matching supports spaces, mid-message caret, and ignores email addresses", () => {
  expect(activeMention("Review @src/a b.ts later", 18)).toEqual({
    start: 7,
    end: 18,
    query: "src/a b.ts",
  });
  expect(activeMention("mail@example.com", 16)).toBeUndefined();
  expect(activeMention("@a\nnext", 7)).toBeUndefined();
});

test("pending context sends are deduplicated, failure keeps draft, success cannot clear newer context", async () => {
  let reject!: (error: Error) => void;
  let calls = 0;
  const store = new ThreadStateStore((() => {
    calls++;
    return new Promise((_, fail) => {
      reject = fail;
    });
  }) as never);
  const attachments = [createRepositoryReference("a.ts")];
  store.update("one", { draft: "Review", attachments });
  const action = {
    type: "prompt" as const,
    text: "Review",
    attachments,
    requestId: "one",
  };
  const pending = store.action("one", action);
  expect(await store.action("one", action)).toBe(false);
  reject(new Error("offline"));
  await pending;
  expect(calls).toBe(1);
  expect(store.get("one")).toMatchObject({
    draft: "Review",
    attachments,
    pending: false,
    error: "offline",
  });
  let resolve!: (snapshot: AcpSnapshot) => void;
  const success = new ThreadStateStore(
    (() =>
      new Promise((done) => {
        resolve = done;
      })) as never,
  );
  success.update("one", { draft: "Review", attachments });
  const request = success.action("one", action);
  const newer = appendRepositoryContext(
    attachments,
    createRepositoryReference("b.ts"),
    capabilities,
  );
  success.update("one", { attachments: newer });
  success.select("two");
  resolve({
    status: "ready",
    messages: [],
    permissions: [],
  } as unknown as AcpSnapshot);
  await request;
  expect(success.get("one").attachments).toBe(newer);
  expect(success.get("two").attachments).toBeUndefined();
});
