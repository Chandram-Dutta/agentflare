type Operation =
  | "start"
  | "delete"
  | "connect"
  | "inspect"
  | "load"
  | "request";

// Match only messages we own. SDK/provider messages can contain credentials,
// prompts, shell commands, and repository contents; never return or log them.
const known = new Map<string, [string, string]>([
  [
    "Workspace archive length is invalid.",
    [
      "workspace_archive_length",
      "The backup archive could not be transferred safely. The previous checkpoint is retained. Recover the workspace from the conversation and share this reference with the operator; do not delete the thread.",
    ],
  ],
  [
    "Workspace is stopped. Resume it before continuing.",
    [
      "workspace_stopped",
      "This workspace is not running. Resume or recover it from the conversation before opening files or sending a message.",
    ],
  ],
  [
    "Agent is busy. Wait for the current operation before suspending.",
    [
      "workspace_busy",
      "The agent is still working or waiting for approval. Finish or stop that operation before saving and suspending.",
    ],
  ],
  [
    "Computer backups are not configured.",
    [
      "workspace_backups_missing",
      "Workspace checkpoints require the BACKUP_BUCKET binding. Ask the operator to configure backups; do not delete this thread.",
    ],
  ],
  [
    "Workspace archive failed.",
    [
      "workspace_archive_failed",
      "The workspace could not be archived. The previous checkpoint is retained. Retry after checking free disk space and background processes modifying files.",
    ],
  ],
  [
    "This thread's sandbox has been deleted.",
    [
      "thread_cleanup_pending",
      "This thread is marked for deletion. Retry deleting it from the thread list, then refresh. Reconnecting cannot restore a deleted thread.",
    ],
  ],
  [
    "Start this thread first.",
    [
      "workspace_not_started",
      "Start this thread's workspace before connecting Codex or opening files.",
    ],
  ],
  [
    "Saved workspace restoration failed.",
    [
      "workspace_restore_failed",
      "The saved workspace could not be restored. Retry opening it. If it fails again, ask the operator to check backup storage using the reference below; do not delete the thread to recover it.",
    ],
  ],
  [
    "Sandbox files are unavailable and the saved workspace could not be restored.",
    [
      "workspace_files_missing",
      "The repository files are unavailable after restore. Retry opening the workspace; if it still fails, ask the operator to check the saved backup before deleting anything.",
    ],
  ],
  [
    "Sandbox files are no longer available because workspace persistence is disabled.",
    [
      "workspace_not_persisted",
      "This sandbox lost its files and workspace persistence is disabled. Start a new thread from GitHub. Unpushed files cannot be recovered from GitHub; enable workspace backups for future threads.",
    ],
  ],
  [
    "Workspace startup failed during checking out repository.",
    [
      "repository_checkout_failed",
      "The repository checkout failed. Check that the GitHub App has access and the repository contains a commit, then retry. If it persists, share the reference below with the operator.",
    ],
  ],
  [
    "Cannot determine the thread's base branch.",
    [
      "repository_base_missing",
      "The repository's default branch could not be determined. Check its default branch and add an initial commit if the repository is empty, then retry startup.",
    ],
  ],
  [
    "Codex bridge did not become ready.",
    [
      "codex_startup_timeout",
      "The workspace started, but Codex did not become ready in time. Wait briefly, then reconnect. If this repeats, share the reference below with the operator.",
    ],
  ],
  [
    "Previous Codex process is still stopping. Retry shortly.",
    [
      "codex_stopping",
      "The previous Codex process is still stopping. Wait briefly, then reconnect; do not repeatedly start new threads.",
    ],
  ],
  [
    "Codex sign-out is in progress.",
    [
      "codex_signing_out",
      "Codex is signing out. Wait for sign-out to finish, then connect and sign in again.",
    ],
  ],
  [
    "Codex sign-out cleanup is pending.",
    [
      "codex_signout_pending",
      "Codex sign-out cleanup has not finished. Retry reconnecting before signing in again.",
    ],
  ],
  [
    "Stop all running Codex threads before signing out.",
    [
      "codex_busy",
      "Stop all running Codex threads before signing out. Check your other projects for active turns.",
    ],
  ],
  [
    "Connect Codex first.",
    ["codex_not_connected", "Reconnect Codex before sending another message."],
  ],
  [
    "Codex bridge request failed.",
    [
      "codex_request_failed",
      "Codex could not handle this request. Reconnect to reload its state before retrying. Check the conversation before resending a prompt; it may already have been accepted.",
    ],
  ],
  [
    "Workspace cleanup failed.",
    [
      "workspace_cleanup_failed",
      "Workspace files could not be removed. Retry deletion from the thread list. If it still fails, share the reference below with the operator.",
    ],
  ],
  [
    "Deleted workspace cleanup failed.",
    [
      "workspace_cleanup_failed",
      "Cleanup of a previously deleted thread failed during restore. Retry opening the workspace; if it repeats, ask the operator to check cleanup using the reference below.",
    ],
  ],
]);

const fallback: Record<Operation, string> = {
  start:
    "Workspace startup failed. Retry once; if it fails again, share the reference below with the operator to check container startup and repository access.",
  delete:
    "Thread deletion did not finish. The thread is still listed and cleanup may be partial. Retry deletion; if it remains stuck, share the reference below with the operator.",
  connect:
    "Codex could not be reached. Reconnect to reload the session before retrying. Check whether your last message was accepted before sending it again.",
  inspect:
    "The workspace could not be read. Reopen it and refresh the file list. If only one file fails, it may be missing, binary, or too large.",
  load: "Thread state could not be loaded. Refresh and retry. If it still fails, share the reference below with the operator; this error alone does not mean your files were deleted.",
  request:
    "This request could not be completed. Refresh and retry; if it repeats, share the reference below with the operator.",
};

export function runtimeFailure(error: unknown, operation: Operation) {
  const [code, message] = (error instanceof Error
    ? known.get(error.message)
    : undefined) ?? [`${operation}_failed`, fallback[operation]];
  const reference = crypto.randomUUID();
  console.error({
    event: "runtime_request_failed",
    operation,
    code,
    reference,
  });
  return { error: `${message} Reference: ${reference}`, code, reference };
}
