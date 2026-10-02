export type WorkspaceLifecycle =
  | "starting"
  | "running"
  | "suspending"
  | "suspended"
  | "recovering"
  | "failed";

export type RuntimeState = {
  started: boolean;
  repository?: string;
  agent?: "codex";
  autoResume?: boolean;
  workspace?: WorkspaceLifecycle;
};
export type RepositoryFile = { path: string; content: string };
export type GitChange = { path: string; index: string; worktree: string };

export type PublishResult = {
  sha: string;
  url: string;
  number: number;
  revision?: string;
};
export type BranchReview = {
  revision: string;
  branch: string;
  baseBranch: string;
  changes: { status: string; path: string }[];
  published?: PublishResult;
};
export type PublishInput = {
  revision: string;
  title: string;
  body: string;
};

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
