export type RuntimeState = {
  started: boolean;
  repository?: string;
  agent?: "claude" | "codex";
};
export type RepositoryFile = { path: string; content: string };
export type GitChange = { path: string; index: string; worktree: string };

export function repositoryPath(value: string): string {
  if (
    !value ||
    value.length > 1024 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(value) ||
    value
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part.toLowerCase() === ".git",
      )
  ) {
    throw new Error("Invalid repository path.");
  }
  return value;
}

export function shellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
