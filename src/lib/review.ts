import type { RepositoryContext } from "./repository-context";

// SHA-256 patch fingerprints only: persisted progress must not contain source.
export type ReviewProgress = { reviewed: Record<string, string> };

export function isReviewed(
  progress: ReviewProgress,
  path: string,
  fingerprint?: string,
) {
  return Boolean(
    fingerprint &&
      Object.hasOwn(progress.reviewed, path) &&
      progress.reviewed[path] === fingerprint,
  );
}

export async function patchFingerprint(patch: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(patch),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export type ReviewSelection = {
  start: number;
  end: number;
  side?: "additions" | "deletions";
  endSide?: "additions" | "deletions";
};

/** Extract only visible lines on one side; never substitute current file text. */
export function reviewCommentContext(input: {
  path: string;
  revision: string;
  patch: string;
  selection: ReviewSelection;
  comment: string;
}): RepositoryContext {
  const { selection, patch, path, revision } = input;
  const side = selection.side ?? "additions";
  if (selection.endSide && selection.endSide !== side)
    throw Error("Select lines on one side of the diff.");
  const start = Math.min(selection.start, selection.end);
  const end = Math.max(selection.start, selection.end);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 1 ||
    end - start > 1000
  )
    throw Error("Select between 1 and 1001 visible lines.");
  const lines = new Map<number, string>();
  let oldLine = 0,
    newLine = 0,
    inHunk = false;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || ![" ", "+", "-"].includes(line[0])) continue;
    const old = line[0] !== "+",
      next = line[0] !== "-";
    if (side === "deletions" ? old : next)
      lines.set(side === "deletions" ? oldLine : newLine, line.slice(1));
    if (old) oldLine++;
    if (next) newLine++;
  }
  const selected: string[] = [];
  for (let line = start; line <= end; line++) {
    if (!lines.has(line))
      throw Error(
        "The selection includes lines outside this patch. Select visible lines only.",
      );
    selected.push(lines.get(line)!);
  }
  if (!input.comment.trim()) throw Error("Write a review comment first.");
  return {
    kind: "selection",
    path,
    startLine: start,
    endLine: end,
    content: `Review request for ${JSON.stringify(path)}\nSnapshot tree: ${revision}\nDiff side: ${side === "deletions" ? "base (old)" : "snapshot (new)"}\nLines: ${start}-${end}\n\nReviewer comment:\n${input.comment.trim()}\n\nExact selected source:\n${selected.join("\n")}`,
  };
}

export type ReviewTestResult = {
  revision: string;
  afterRevision: string;
  command: string;
  exitCode: number | null;
  output: string;
  finishedAt: string;
};

export function testResultState(result: ReviewTestResult, revision: string) {
  if (result.revision !== revision || result.afterRevision !== result.revision)
    return "stale";
  if (result.exitCode === null) return "incomplete";
  return result.exitCode === 0 ? "passed" : "failed";
}
