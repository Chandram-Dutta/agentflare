import { expect, test } from "bun:test";
import { resolveRepositoryLink } from "./repository-links";

const threadId = "600c7823-f2e5-4fec-95aa-3b71ddb851a2";
const root = `/workspace/threads/${threadId}/repo`;
const origin = "https://agentflare.onlychan.xyz";

test("resolves absolute, legacy and relative repository file references", () => {
  for (const href of [
    `${root}/README.md`,
    "/workspace/repo/README.md",
    "README.md",
    "./README.md",
    `${origin}${root}/README.md`,
  ]) {
    expect(resolveRepositoryLink(href, threadId, origin)).toEqual({
      path: "README.md",
    });
  }
  expect(resolveRepositoryLink(`${root}/docs/My%20File.md`, threadId)).toEqual({
    path: "docs/My File.md",
  });
  expect(resolveRepositoryLink("src/app/page.tsx", threadId)).toEqual({
    path: "src/app/page.tsx",
  });
});

test("extracts line numbers, column references and line ranges", () => {
  for (const href of [
    `${root}/README.md:12`,
    `${root}/README.md:12:3`,
    "src/page.tsx#L12",
    "src/page.tsx#12",
  ]) {
    expect(resolveRepositoryLink(href, threadId)).toEqual({
      path: href.includes("README") ? "README.md" : "src/page.tsx",
      startLine: 12,
    });
  }
  expect(resolveRepositoryLink("./src/page.tsx#L12-L20", threadId)).toEqual({
    path: "src/page.tsx",
    startLine: 12,
    endLine: 20,
  });
  expect(
    resolveRepositoryLink(`${origin}${root}/README.md#L12`, threadId, origin),
  ).toEqual({ path: "README.md", startLine: 12 });
});

test("leaves web, application and fragment links alone", () => {
  for (const href of [
    "https://example.com/src/page.tsx#L12",
    `https://example.com${root}/README.md`,
    "https://github.com/owner/repo/blob/main/README.md#L12",
    `${origin}/api/threads`,
    "//example.com/README.md",
    "mailto:person@example.com",
    "javascript:alert(1)",
    "data:text/html,bad",
    "/api/threads",
    "#heading",
    "README.md#heading",
    "?path=README.md",
    "README.md?raw=true",
  ])
    expect(resolveRepositoryLink(href, threadId, origin)).toBeNull();
});

test("rejects cross-thread paths, traversal, malformed paths and invalid lines", () => {
  for (const href of [
    "/workspace/threads/another-thread/repo/README.md",
    "/etc/passwd",
    `${root}/../secret`,
    `${root}/%2e%2e/secret`,
    "../secret",
    "src/../../secret",
    ".git/config",
    "src\\page.tsx",
    "src/%00page.tsx",
    "bad%ZZ.md",
    `${root}/`,
    "README.md#L0",
    "README.md#L20-L12",
    "README.md#L9007199254740992",
  ])
    expect(resolveRepositoryLink(href, threadId, origin)).toBeNull();
});
