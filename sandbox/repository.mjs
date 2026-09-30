import {
  readdirSync,
  realpathSync,
  readFileSync,
  statSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Build a stable tree without changing the agent's index or working files.
export function snapshotRepository(root, base, includeBlobs = false) {
  if (!/^[a-f0-9]{40}$/.test(base)) throw Error("Invalid base");
  const temp = mkdtempSync(resolve(tmpdir(), "agentflare-index-"));
  const env = {
    ...process.env,
    GIT_INDEX_FILE: resolve(temp, "index"),
    GIT_NO_REPLACE_OBJECTS: "1",
  };
  const git = (...args) =>
    execFileSync("git", ["--literal-pathspecs", "-C", root, ...args], {
      env,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 15000,
    });
  try {
    git("read-tree", "HEAD");
    git("add", "-A", "--", ".");
    const revision = git("write-tree").toString().trim();
    const changes = git(
      "diff",
      "--name-status",
      "--no-renames",
      "-z",
      base,
      revision,
    )
      .toString()
      .split("\0");
    const result = {
      revision,
      branch: git("branch", "--show-current").toString().trim(),
      changes: [],
    };
    for (let i = 0; i < changes.length - 1; i += 2)
      result.changes.push({ status: changes[i], path: changes[i + 1] });
    if (includeBlobs) {
      const known = new Set(
        git("ls-tree", "-r", base)
          .toString()
          .split("\n")
          .map((line) => line.split(/[ \t]/)[2]),
      );
      let size = 0;
      const blobs = {};
      const entries = git("ls-tree", "-rz", revision)
        .toString()
        .split("\0")
        .filter(Boolean)
        .map((line) => {
          const split = line.indexOf("\t");
          const [mode, type, sha] = line.slice(0, split).split(" ");
          if (type === "blob" && !known.has(sha) && !blobs[sha]) {
            const content = git("cat-file", "blob", sha);
            size += content.length;
            if (size > 4 * 1024 * 1024)
              throw Error("Publish exceeds 4 MiB of changed content");
            blobs[sha] = content.toString("base64");
          }
          return { mode, type, sha, path: line.slice(split + 1) };
        });
      if (entries.length > 10000) throw Error("Publish exceeds 10000 files");
      Object.assign(result, { entries, blobs });
    }
    return result;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/**
 * @returns {{ files?: string[], path?: string, content?: string, patch?: string,
 * changes?: object[], branch?: string, revision?: string, entries?: object[], blobs?: Record<string, string> }}
 */
export function inspectRepository(root, { operation, path, staged, base = "" }) {
  function checkedPath(path) {
    if (
      !path ||
      path.includes("\\") ||
      path
        .split("/")
        .some(
          (p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git",
        )
    )
      throw Error("Invalid path");
    const full = resolve(root, path);
    const actual = realpathSync(full);
    if (
      !actual.startsWith(`${root}/`) ||
      relative(root, actual).split("/").includes(".git")
    )
      throw Error("Path outside checkout");
    return full;
  }
  function git(...args) {
    return execFileSync("git", ["--literal-pathspecs", "-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 10000,
    });
  }
  let result;
  if (operation === "review" || operation === "snapshot") {
    result = snapshotRepository(root, base, operation === "snapshot");
  } else if (operation === "branch-diff") {
    if (
      !path ||
      path.startsWith("/") ||
      path.split("/").some((p) => p === ".." || p === ".git")
    )
      throw Error("Invalid path");
    const snapshot = snapshotRepository(root, base);
    result = {
      patch: git(
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        base,
        snapshot.revision,
        "--",
        path,
      ),
    };
  } else if (operation === "files") {
    const files = [];
    function walk(dir, depth = 0) {
      if (depth > 20) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (
          [".git", "node_modules", ".next", "dist"].includes(entry.name) ||
          entry.isSymbolicLink()
        )
          continue;
        if (files.length >= 5000) throw Error("Too many files");
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.isFile()) files.push(relative(root, full));
      }
    }
    walk(root);
    result = { files: files.sort() };
  } else if (operation === "file") {
    const full = checkedPath(path);
    if (statSync(full).size > 256 * 1024) throw Error("File too large");
    const content = readFileSync(full, "utf8");
    if (content.includes("\0")) throw Error("Binary file");
    result = { path, content };
  } else if (operation === "git") {
    const parts = git(
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ).split("\0");
    const changes = [];
    for (let i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      const index = parts[i][0],
        worktree = parts[i][1];
      changes.push({ path: parts[i].slice(3), index, worktree });
      if (
        index === "R" ||
        index === "C" ||
        worktree === "R" ||
        worktree === "C"
      )
        i++;
    }
    result = { changes, branch: git("branch", "--show-current").trim() };
  } else if (operation === "diff") {
    // Deleted paths do not exist, so lexical containment is required here.
    if (
      !path ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").some((p) => !p || p === "." || p === ".." || p === ".git")
    )
      throw Error("Invalid path");
    result = {
      patch: git(
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        ...(staged ? ["--cached"] : []),
        "--",
        path,
      ),
    };
  } else throw Error("Unknown operation");
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (!process.argv[3]) throw Error("Repository root is required");
  process.stdout.write(
    JSON.stringify(
      inspectRepository(
        process.argv[3],
        JSON.parse(Buffer.from(process.argv[2], "base64").toString()),
      ),
    ),
  );
}
