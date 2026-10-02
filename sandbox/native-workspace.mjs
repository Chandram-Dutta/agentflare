import { writeFile } from "node:fs/promises";
import { createWorkspaceArchive } from "./acp/workspace-archive.mjs";

// Separate from Codex: recovery must finish before an agent can read the tree,
// and saving must still work after that agent has been quiesced.
const archive = createWorkspaceArchive();
Bun.serve({
  hostname: "0.0.0.0",
  port: 8767,
  maxRequestBodySize: 2 * 1024 ** 3,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return new Response(null, { status: 204 });
    if (path === "/workspace-archive") return archive(request);
    return new Response(null, { status: 404 });
  },
});
await writeFile("/run/agentflare-ready", "ready");
