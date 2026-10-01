# Architecture

[README](../README.md) · [Self-hosting](self-hosting.md)

Agentflare owns account access, workspaces, code review, and publishing. Codex
owns model and tool execution through an Agent Client Protocol (ACP) adapter.
There is no browser terminal in the current UI.

## Components

```text
Browser: projects, conversations, files, diffs
    │ HTTPS
    ▼
Cloudflare Worker: vinext + Hono + Better Auth
    ├── D1: accounts, projects, threads
    ├── GitHub App: access checks and PR publishing
    └── Per-user Durable Object: runtime coordination and checkpoint pointers
            ├── Container: ACP bridge, Codex, thread checkouts
            └── Private R2: conversation snapshots and workspace archives
```

| Area | Source |
| --- | --- |
| App routes and workspace UI | [`src/app`](../src/app), [`src/components`](../src/components) |
| Worker entry and API | [`src/worker.ts`](../src/worker.ts), [`src/server/api.ts`](../src/server/api.ts) |
| Authentication and configuration | [`auth.ts`](../src/server/auth.ts), [`env.ts`](../src/server/env.ts) |
| Database schema | [`src/server/db`](../src/server/db) |
| Runtime and persistence | [`sandbox.ts`](../src/server/sandbox.ts), [`user-runtime.ts`](../src/server/user-runtime.ts) |
| ACP bridge | [`sandbox/acp/bridge.mjs`](../sandbox/acp/bridge.mjs) |
| Repository access and publishing | [`github.ts`](../src/server/github.ts), [`publish.ts`](../src/server/publish.ts) |
| Safe runtime errors | [`runtime-errors.ts`](../src/server/runtime-errors.ts) |

## Ownership and isolation

Each account owns its projects and threads. Private API requests check the session,
resource ownership, and configured admission policy; browser writes require the
configured origin. File operations enforce path boundaries and stale-edit checks.

Each user has one sandbox and one shared ACP process, with a separate checkout per
thread. **Threads belonging to one user are not security boundaries:** an agent
can access that user's sibling checkouts. Different users have separate sandboxes.
Agents execute arbitrary code and can access the network inside their container.

Starting a workspace checks the signed-in user's repository access before using
the GitHub App installation. Clone tokens are short-lived, repository-scoped, and
read-only; they are not retained in Git configuration. The App private key and
user OAuth token never enter the sandbox.

## Conversations and authentication

The sandbox bridge owns turns, approvals, and native session IDs. Reloading a
browser does not restart a turn. The UI polls active conversation snapshots roughly
once per second rather than using a push stream. Mode, model, reasoning, and fast
mode controls appear only when the adapter advertises them. Context usage is the
last reported estimate, not subscription quota or billing usage.

Codex uses its native ChatGPT device-code sign-in. One login serves all of a user's
projects and threads; the operator does not supply an OpenAI client secret or API
key. One Codex app-server owns token refresh. Auth-file changes are checked every
second and checkpointed through a private runtime capability. The Worker encrypts
credentials with AES-GCM in the user's Durable Object, using a key derived from
`BETTER_AUTH_SECRET` and bound to that runtime's identity.

A replacement container restores saved credentials, but an existing auth file
takes precedence to avoid reverting a newer token rotation. Provider revocation,
expiration, or a crash before saving a rotation can require sign-in again. Codex
sign-out affects all of the user's threads and is blocked while any is busy; it
does not delete conversations. GitHub sign-out is separate.

## Checkpoint recovery

R2 persistence has two parts: saved conversations, which can update during a turn,
and workspace archives, which wait until **all user threads are idle and no
browser has accessed the runtime for 30 seconds**. Visible runtime polling renews
that presence lease. The bridge requests saves after turns settle and on a
30-second interval, including when the browser is closed.

Before archiving, the bridge quiesces its managed Codex processes. Archives cover
`/workspace`, including Git metadata, staging, untracked and ignored files, and
native Codex session history. Codex credentials are excluded and stored separately
as encrypted auth checkpoints. A failed upload preserves the previous archive.
Returning during an archive can wait for it to finish.

**This restores checkpoints, not processes.** Forced container loss can lose work
since the last successful archive; saved chat may be newer than restorable files.
Files outside `/workspace`, background servers, and process memory are not restored.
Interrupted prompts and approvals are not automatically resubmitted. A failed
native session load is reported instead of silently replacing the conversation.

Deleting a thread removes its checkout and saved transcript only after cleanup
succeeds. Durable deletion markers prevent older archives from resurrecting it.
Sibling threads, shared login, and pushed GitHub branches remain. User-wide native
Codex session records can remain in the shared archive.

R2 contains source code and potentially secrets written by agents. Keep it private.
Do not expire `backups/` or `runtime-snapshots/` objects through lifecycle rules.
Archives use the SDK's required finite TTL (100 years); superseded archives are
removed after successful replacement.

## Review and publish

The file and Git inspector refreshes while visible. Branch-wide Changes compares
the thread snapshot with its starting base, covering agent commits and uncommitted
files. Pierre Trees and Diffs render repository data; they do not authorize file
operations. DiffsHub is a design reference, not a service receiving users' code.

Publishing creates a snapshot commit on `agentflare/<thread-id>` and opens a draft
PR. Updates append snapshots to that branch. Local commits, staging, and files are
untouched; local commit history is not copied. The base is the repository default
branch at startup. Merging and CI remain on GitHub.

Write tokens exist only in the Worker and are revoked after publishing. The remote
branch is never force-pushed; changed local or remote state requires renewed review
or stops publication. Limits are 10,000 tree entries and 4 MiB of changed blob
content. Repository rules and workflow-file permissions can still reject writes.
A confirmation UI cannot prevent native pushes if someone separately gives the
agent write credentials: authorization must hold at the credential boundary.

## Admission and notifications

Self-hosted admission is open to GitHub accounts and uncapped by default. An
optional allowlist restricts a private install. Hosted quotas are maintained on
`feat/hosted-account-limits`, separately from `main`. Container pool capacity
still applies; uncapped project counts do not imply unlimited compute resources.

Desktop notifications require explicit permission and an open tab. Hidden tabs
poll activity about every ten seconds without waking a sandbox or renewing its
presence lease. Browser throttling may delay notifications; closing the tab stops
delivery. Initial activity is a baseline, not a new completion event.

## Verification boundaries

Tests use disposable repositories and D1 data for ownership, quotas, origins,
paths, Git behavior, and publishing. GitHub calls are mocked. ACP tests exercise
the real SDK against a scripted subprocess for streaming, approvals, cancellation,
process death, and session replay. They do not prove real subscription entitlement
or Cloudflare container availability; deployment still needs an authenticated
end-to-end smoke test.
