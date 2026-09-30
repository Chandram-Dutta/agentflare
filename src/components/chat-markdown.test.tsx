import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMarkdown } from "./chat-markdown";

test("renders code literally and supports headings, lists, tables and task lists", () => {
  const html = renderToStaticMarkup(
    <ChatMarkdown>
      {
        "## Result\n\n**Done** with `x < 2`.\n\n- [x] tested\n- [ ] shipped\n\n```ts\nconst tag = '<script>';\n```\n\n| Name | State |\n| --- | --- |\n| API | Ready |"
      }
    </ChatMarkdown>,
  );
  expect(html).toContain("<h2>Result</h2>");
  expect(html).toContain("<strong>Done</strong>");
  expect(html).toContain("<code>x &lt; 2</code>");
  expect(html).toContain('class="language-ts"');
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain('type="checkbox" disabled="" checked=""');
  expect(html).toContain("<td>Ready</td>");
});

test("renders HTML and remote images but strips executable markup and unsafe URLs", () => {
  const html = renderToStaticMarkup(
    <ChatMarkdown>
      {
        '<script>alert(1)</script>\n\n<details open><summary>Details</summary><b>Raw HTML</b></details>\n\n<img src="https://images.test/raw" onerror="alert(2)">\n\n[bad](javascript:alert%281%29)\n\n![preview](https://images.test/preview)\n\n[docs](https://example.com)'
      }
    </ChatMarkdown>,
  );
  expect(html).not.toContain("<script");
  expect(html).not.toContain("onerror");
  expect(html).toContain("<b>Raw HTML</b>");
  expect(html).toContain("<summary>Details</summary>");
  expect(html).toContain('src="https://images.test/raw"');
  expect(html).toContain('src="https://images.test/preview"');
  expect(html).toContain('referrerPolicy="no-referrer"');
  expect(html).not.toContain("javascript:");
  expect(html).toContain(
    'href="https://example.com" target="_blank" rel="noopener noreferrer"',
  );
});
