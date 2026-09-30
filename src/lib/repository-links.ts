export type RepositoryFileLink = {
  path: string;
  startLine?: number;
  endLine?: number;
};

/** Resolve agent file references against the repository belonging to this thread. */
export function resolveRepositoryLink(
  href: string | undefined,
  threadId: string,
  origin?: string,
): RepositoryFileLink | null {
  if (!href || href.startsWith("//")) return null;
  let value = href;
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.origin !== origin || url.search || url.username || url.password)
        return null;
      value = url.pathname + url.hash;
    } catch {
      return null;
    }
  }

  const [pathname, fragment, ...extra] = value.split("#");
  if (!pathname || pathname.includes("?") || extra.length) return null;
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const suffix = path.match(/:(\d+)(?::\d+)?$/);
  // A root filename plus a numeric location looks like a URL scheme to a URL
  // parser. Recognize it before scheme rejection, but require an extension so
  // actual schemes such as javascript: and data: remain rejected.
  const rootLocation =
    suffix &&
    !path.slice(0, suffix.index).includes("/") &&
    path.slice(0, suffix.index).includes(".");
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !rootLocation) return null;
  if (suffix) path = path.slice(0, suffix.index);
  const lines = fragment?.match(/^L?(\d+)(?:-L?(\d+))?$/i);
  if (fragment !== undefined && !lines) return null;
  const startLine = lines
    ? Number(lines[1])
    : suffix
      ? Number(suffix[1])
      : undefined;
  const endLine = lines?.[2] ? Number(lines[2]) : undefined;
  if (
    (startLine !== undefined &&
      (!Number.isSafeInteger(startLine) || startLine < 1)) ||
    (endLine !== undefined &&
      (!Number.isSafeInteger(endLine) || endLine < (startLine ?? 1)))
  )
    return null;

  const roots = [`/workspace/threads/${threadId}/repo/`, "/workspace/repo/"];
  if (path.startsWith("/")) {
    const root = roots.find((root) => path.startsWith(root));
    if (!root) return null;
    path = path.slice(root.length);
  }
  const segments = path.split("/").filter((segment) => segment !== ".");
  if (
    !segments.length ||
    segments.some(
      (segment) => !segment || segment === ".." || segment === ".git",
    ) ||
    path.includes("\\") ||
    Array.from(path).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    return null;
  return {
    path: segments.join("/"),
    ...(startLine === undefined ? {} : { startLine }),
    ...(endLine === undefined ? {} : { endLine }),
  };
}
