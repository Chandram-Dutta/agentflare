import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

// Internal Computer-only endpoint. Archives are outside the synced tree and
// streamed to/from R2 by the Worker; no storage credentials enter the container.
export function createWorkspaceArchive(
  root = "/workspace",
  temporary = "/run/agentflare-backup",
) {
  const archive = join(temporary, "workspace.tar.gz");
  let busy = false;
  async function tar(args) {
    const process = Bun.spawn(["tar", ...args], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if ((await process.exited) !== 0) throw Error("Workspace archive failed.");
  }
  return async (request) => {
    if (busy) return new Response(null, { status: 409 });
    busy = true;
    try {
      await mkdir(temporary, { recursive: true, mode: 0o700 });
      if (request.method === "GET") {
        await tar(["-czf", archive, "-C", root, "."]);
        const file = Bun.file(archive);
        // Never commit an archive larger than the bridge can accept on restore.
        if (file.size > 2 * 1024 ** 3)
          return new Response("Workspace archive exceeds 2 GiB.", {
            status: 413,
          });
        return new Response(file, {
          headers: {
            "Content-Type": "application/gzip",
            "Content-Length": String(file.size),
          },
        });
      }
      if (request.method === "POST") {
        if (!request.body) return new Response(null, { status: 400 });
        await Bun.write(archive, new Response(request.body));
        // Validate the complete archive before replacing the live tree. This
        // endpoint accepts only the Worker's private, previously committed object.
        await tar(["-tzf", archive]);
        for (const path of await readdir(root))
          await rm(join(root, path), { recursive: true, force: true });
        await tar(["-xzf", archive, "-C", root, "--no-same-owner"]);
        return new Response(null, { status: 204 });
      }
      if (request.method === "DELETE") {
        await rm(archive, { force: true });
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 405 });
    } catch {
      return new Response("Workspace archive failed.", { status: 500 });
    } finally {
      busy = false;
    }
  };
}
