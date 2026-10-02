<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Workspace UI principles

- Show, don't tell. Prefer the work itself over explanatory cards and instructional prose.
- Hide empty sections and absent results; do not render placeholder status panels.
- Use compact Lucide icon actions with accessible names and hover titles for familiar operations.
- Keep detailed status, timings, and diagnostics behind deliberate disclosure. Show actionable errors when they occur.
- Keep text for consequential choices, unfamiliar actions, and destructive confirmations. Do not hide meaning just to remove words.
- Follow an editor's visual language: restrained chrome, consistent spacing, and content-first panes, not dashboard cards or marketing copy.
