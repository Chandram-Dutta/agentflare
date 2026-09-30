import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AcpMessages } from "./acp-messages";

test("tool disclosures use reported statuses and collapse only completed calls", () => {
  for (const status of [
    "completed",
    "in_progress",
    "failed",
    "pending",
    "custom",
    undefined,
  ]) {
    const html = renderToStaticMarkup(
      <AcpMessages
        messages={[
          { id: "tool", role: "tool", text: "Run checks\nresult", status },
        ]}
      />,
    );
    expect(html).toContain(`aria-expanded="${status !== "completed"}"`);
    expect(html.includes('hidden=""')).toBe(status === "completed");
    if (status) expect(html).toContain(status);
    else expect(html).not.toContain("completed");
    expect(html).toContain('role="region"');
    expect(html).toContain('tabindex="0"');
  }
});

test("tool text remains literal, including whitespace and a long output tail", () => {
  const output = `  <script>bad()</script>\n**not bold**\n\n${"line\n".repeat(400)}last line  `;
  const html = renderToStaticMarkup(
    <AcpMessages
      messages={[
        {
          id: "tool",
          role: "tool",
          text: `Run <checks>\n${output}`,
          status: "failed",
        },
      ]}
    />,
  );
  expect(html).toContain("Run &lt;checks&gt;");
  expect(html).toContain(
    "  &lt;script&gt;bad()&lt;/script&gt;\n**not bold**\n\n",
  );
  expect(html).toContain("last line  </pre>");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<strong>");
});

test("thoughts stay distinct while prose retains sanitized HTML and remote images", () => {
  const html = renderToStaticMarkup(
    <AcpMessages
      messages={[
        { id: "thought", role: "thought", text: "**Reasoning**" },
        {
          id: "assistant",
          role: "assistant",
          text: "<b>Result</b>\n\n![preview](https://images.test/preview)\n\n<script>bad()</script>",
        },
      ]}
    />,
  );
  expect(html).toContain("<details");
  expect(html).not.toContain('open=""');
  expect(html).toContain("Thinking");
  expect(html).toContain("<strong>Reasoning</strong>");
  expect(html).toContain("<b>Result</b>");
  expect(html).toContain('src="https://images.test/preview"');
  expect(html).not.toContain("<script>");
});

test("rich messages keep block order and repository navigation without duplicate text", () => {
  const html = renderToStaticMarkup(
    <AcpMessages
      threadId="t"
      onOpenFile={() => {}}
      messages={[
        {
          id: "rich",
          role: "assistant",
          text: "fallback must not duplicate",
          content: [
            { type: "text", text: "**Before**" },
            { type: "image", mimeType: "image/png", data: "aGk=" },
            { type: "text", text: "[Readme](README.md:12)" },
          ],
        },
      ]}
    />,
  );
  expect(html.match(/<article/g)).toHaveLength(1);
  expect(html).not.toContain("fallback must not duplicate");
  expect(html.indexOf("<strong>Before")).toBeLessThan(html.indexOf("<img"));
  expect(html.indexOf("<img")).toBeLessThan(html.indexOf(">Readme</button>"));
  expect(html).not.toContain('href="README');
});

test("rich tool text stays literal and keyboard-accessible", () => {
  const html = renderToStaticMarkup(
    <AcpMessages
      messages={[
        {
          id: "tool",
          role: "tool",
          text: "Read file",
          status: "failed",
          content: [
            { type: "text", text: "<script>unsafe</script> **literal**" },
          ],
        },
      ]}
    />,
  );
  expect(html).toContain('role="region"');
  expect(html).toContain('tabindex="0"');
  expect(html).toContain("&lt;script&gt;unsafe&lt;/script&gt; **literal**");
  expect(html).not.toContain("<script>");
});
