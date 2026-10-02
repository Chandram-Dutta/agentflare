import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AcpComposerControls } from "./acp-composer-controls";
import { ThreadAttentionInbox } from "./thread-attention";
import { ThreadStateProvider } from "./thread-state";
import { ReviewTests } from "./review-tests";

test("empty attention and unreported agent controls do not occupy UI", () => {
  expect(
    renderToStaticMarkup(
      <ThreadStateProvider>
        <ThreadAttentionInbox projects={[]} threads={[]} onSelect={() => {}} />
      </ThreadStateProvider>,
    ),
  ).toBe("");
  expect(
    renderToStaticMarkup(
      <AcpComposerControls disabled={false} onAction={() => {}} />,
    ),
  ).toBe("");
});

test("reported context remains available without settings", () => {
  const html = renderToStaticMarkup(
    <AcpComposerControls
      disabled={false}
      onAction={() => {}}
      contextUsage={{ used: 30, size: 100 }}
    />,
  );
  expect(html).toContain('aria-label="Context estimate details"');
  expect(html).toContain("30%");
});

test("tests remain discoverable without a fabricated empty result strip", () => {
  const html = renderToStaticMarkup(
    <ReviewTests
      base="/runtime"
      review={{
        revision: "a".repeat(40),
        branch: "work",
        baseBranch: "main",
        changes: [],
      }}
    />,
  );
  expect(html).toContain('aria-label="Run tests"');
  expect(html).not.toContain("not recorded");
  expect(html).not.toContain("not fetched");
});
