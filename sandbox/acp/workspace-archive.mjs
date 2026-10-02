import { mkdir, readdir, rm, lstat, readlink } from "node:fs/promises";
import { createReadStream, constants } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

// Hash the actual archive inputs, not agent activity or a tracked-files Git tree.
// No archive/compression or buffering of entire files is needed for this check.
async function fingerprint(root) {
  const digest = createHash("sha256");
  const links = new Map();
  async function visit(relative) {
    const path = join(root, relative);
    const before = await lstat(path);
    const entry = [
      relative,
      before.mode,
      before.uid,
      before.gid,
      before.mtimeMs,
    ];
    if (before.isDirectory()) {
      digest.update(JSON.stringify([...entry, "directory"]));
      for (const child of (await readdir(path)).sort())
        await visit(join(relative, child));
    } else if (before.isSymbolicLink()) {
      digest.update(
        JSON.stringify([...entry, "symlink", await readlink(path)]),
      );
    } else if (before.isFile()) {
      const content = createHash("sha256");
      for await (const chunk of createReadStream(path, {
        flags: constants.O_RDONLY | constants.O_NOFOLLOW,
      }))
        content.update(chunk);
      const key = `${before.dev}:${before.ino}`;
      const linked = before.nlink > 1 ? links.get(key) : undefined;
      if (before.nlink > 1 && !linked) links.set(key, relative);
      digest.update(
        JSON.stringify([
          ...entry,
          "file",
          before.size,
          linked,
          content.digest("hex"),
        ]),
      );
    } else {
      throw Error("Unsupported workspace file type.");
    }
    const after = await lstat(path);
    if (
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw Error("Workspace changed during fingerprint.");
  }
  await visit("");
  return digest.digest("hex");
}

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
      if (request.method === "HEAD") {
        return new Response(null, {
          headers: { "X-Workspace-Fingerprint": await fingerprint(root) },
        });
      }
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
