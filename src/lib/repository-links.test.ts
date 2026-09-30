import { expect, test } from "bun:test";
import { resolveRepositoryLink } from "./repository-links";

const threadId = "600c7823-f2e5-4fec-95aa-3b71ddb851a2";
const root = `/workspace/threads/${threadId}/repo`;
const origin = "https://agentflare.onlychan.xyz";

test("resolves repository paths and locations", () => {
  for (const href of [
    `${root}/README.md`,
    "/workspace/repo/README.md",
    "README.md",
    "./README.md",
    `${origin}${root}/README.md`,
  ])
    expect(resolveRepositoryLink(href, threadId, origin)).toEqual({
      path: "README.md",
    });

  expect(resolveRepositoryLink("README.md:12", threadId)).toEqual({
    path: "README.md",
    startLine: 12,
  });
  expect(resolveRepositoryLink("package.json:3", threadId)).toEqual({
    path: "package.json",
    startLine: 3,
  });
  expect(resolveRepositoryLink("src/page.tsx#L12-L20", threadId)).toEqual({
    path: "src/page.tsx",
    startLine: 12,
    endLine: 20,
  });
});

test("rejects web/application links, traversal, and cross-thread paths", () => {
  for (const href of [
    "https://example.com/src/page.tsx#L12",
    "mailto:person@example.com",
    "javascript:alert(1)",
    "javascript:12",
    "data:text/html,bad",
    "/api/threads",
    "#heading",
    "README.md#heading",
    "/workspace/threads/another-thread/repo/README.md",
    `${root}/../secret`,
    `${root}/%2e%2e/secret`,
    "../secret",
    ".git/config",
    "src\\page.tsx",
    "README.md#L0",
    "README.md#L20-L12",
  ])
    expect(resolveRepositoryLink(href, threadId, origin)).toBeNull();
});
