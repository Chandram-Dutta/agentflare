import { readdirSync, realpathSync, readFileSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function inspectRepository(root, { operation, path, staged }) {
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
  if (operation === "files") {
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
  process.stdout.write(
    JSON.stringify(
      inspectRepository(
        "/workspace/repo",
        JSON.parse(Buffer.from(process.argv[2], "base64").toString()),
      ),
    ),
  );
}
