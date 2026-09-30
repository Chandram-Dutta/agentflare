# Agentflare

Development workspaces with Codex over ACP: threads, agent conversation,
file/diff view, and Files/Git navigation in resizable panes.

## Current milestone

A persistent, authenticated workspace with an initial Cloudflare Sandbox runtime:

- Next.js App Router structure on vinext/Vite and Cloudflare Workers.
- TypeScript, Bun, Tailwind, shadcn/ui, and Hono.
- GitHub sign-in through Better Auth; closed-by-default GitHub account allowlist.
- D1/Drizzle projects and threads, private to their owner and saved across reloads.
- Project tabs, per-project threads, a Codex conversation and a Files/Git stage inspector.
- Monospace light/dark workspace with Codex conversation UI; no browser terminal.
- Server-side ownership checks, exact-origin write protection and stale-edit detection.

Each started thread checks user and GitHub App repository access and gets its own
checkout/branch. New Codex threads share one sandbox and one ACP process per user.
Threads are separate working directories, not security boundaries; an agent can
access that same user's other checkouts. Different users have separate sandboxes.
The sandbox bridge owns the conversation and pending approvals, so browser reloads
do not restart a turn. The UI polls snapshots once per second; this is not yet a
push-streaming transport. Files and Git use Pierre Trees/Diffs with actual
repository data and refresh every five seconds while the page is visible.
The open file/diff refreshes in place. Changes shows the complete thread snapshot
against its starting base, including agent commits and uncommitted files.

From Changes, **Create draft PR** reviews all changed paths and asks for a title
and description. Confirmation publishes one snapshot commit to `agentflare/<thread-id>`
and creates a draft PR; **Update PR** appends another snapshot to the same branch.
Local commits, files and staging are untouched; local commit history is not copied.
The base is the repository default branch at startup, not a user-selectable branch
yet. Merging, checks and marking ready for review remain on GitHub. Publishing all
files is supported; partial-file staging/publishing is not part of this UI yet.

Publishing requires user write access and GitHub App **Contents: read/write** plus
**Pull requests: read/write** permissions (approve updated installation permissions
after changing the App). A repository-scoped write token is used only in the Worker,
never in the agent container, and revoked after the operation. The remote branch is
never force-pushed. A changed checkout requires another review; an externally changed
remote branch stops publication. Interrupted ref/PR writes can be retried without
duplicating an already-published commit/PR. The initial limits are 10,000 tree entries
and 4 MiB of changed blob content relative to the starting base. Workflow permission
restrictions and repository branch rules can still reject publication.

Use the trash button beside a thread to delete its checkout and uncommitted files.
This keeps the user's login and other threads. Confirmation is required.
Cleanup must succeed before thread metadata is removed; failed cleanup can be
retried. Pushed GitHub branches are not deleted.

### Persistent Codex threads

With R2 configured, shared Codex threads save conversation snapshots and workspace
checkpoints. Reopening a thread displays its saved history without booting a
container. **Resume workspace** restores the latest workspace checkpoint on a
fresh disk, then loads the native Codex session. Interrupted prompts and approvals
are never automatically submitted again. A failed native session load is an error,
not permission to silently start a different conversation.

The bridge requests a checkpoint after a turn settles and every 30 seconds while
alive, including when the browser is closed. Conversation snapshots can save
during a turn; workspace archives wait until **all of the user's threads are idle
and no browser has accessed the runtime for 30 seconds**. Visible conversation and
repository polling renew that presence lease across all of the user's projects.
This avoids stopping Codex and blocking interactive requests between messages.
After closing or backgrounding every workspace tab, the next checkpoint tick can
save the files. File changes remain pending while the workspace is actively open;
this is an idle-save policy, not a non-blocking live filesystem snapshot. Returning
while an archive is already in progress can still wait for that archive to finish.
The bridge stops its managed Codex processes before archiving the whole
`/workspace`: per-thread repositories (including `.git`, staging, untracked and
ignored files) and shared native session state. Credentials in `.codex/auth.json`
are excluded and remain in the separate encrypted auth store. Checkout and deletion
requests follow the same presence rule; controlled idle shutdown performs a final
checkpoint under the shutdown fence. Failed uploads preserve
the last successful archive; the UI reports pending or failed saves.

**This is checkpoint recovery, not process recovery.** A forced container loss
can lose work since the last successful checkpoint. Saved chat can be newer than
restorable files. Background servers and externally detached processes are not
resumed; avoid relying on their in-flight writes during a checkpoint. Files outside
`/workspace` are not saved.
Without the R2 configuration below, the UI says workspace saving is disabled.

Deleting a thread removes its saved transcript and checkout; durable deletion
markers also remove it when restoring an older archive. Other threads and the
user's shared login survive. Native Codex session records are user-wide and can
remain in the shared archive. The private bucket contains source code and anything
an agent wrote to `/workspace`, potentially including secrets: restrict access,
do not enable public hosting, and do not use expiration lifecycle rules.

Clone credentials are short-lived and read-only, not left in Git configuration.
The publishing UI does not grant native `git push` access to the agent.

### Codex sign-in

Start a Codex thread, choose **Sign in with ChatGPT**, open the OpenAI link and
enter the displayed device code. Enable device-code authorization in your ChatGPT
settings if OpenAI requires it. This uses Codex's native subscription login, not
Agentflare's own subscription-sharing OAuth registration. No OpenAI client secret
or API key is needed by the operator.

New Codex threads use one native login per user, shared across projects and threads.
Only one Codex app-server owns refresh tokens; tokens are not copied between active
agent processes. The bridge checkpoints the native auth file on changes (checked
every second, including while browsers are closed) through a private per-runtime
capability. The Worker encrypts it with AES-GCM and stores it in that user's Durable
Object. The key derives from `BETTER_AUTH_SECRET` with a separate key domain, and
the ciphertext is bound to the runtime identity. Never rotate that secret without
planning for users to sign in again. Credentials never go to the browser.

A replacement container restores the login; a surviving auth file takes precedence
over the backup to avoid rolling back a newer token rotation. A crash before a
rotation is checkpointed, provider revocation, or expired authorization can still
require reauthorization. The UI reports pending backups; this is not a guarantee
of perpetual authentication. No additional operator OpenAI key is required.

Existing threads retain their original `runtime=thread` sandbox and login. They
are not moved or destroyed by the migration. Create a new Codex thread and sign in
once to begin using the shared runtime. Apply the additive D1 migration before
deploying this code and rebuild the container image; reusing the old image is not
supported for this release. R2 recovery applies only to shared Codex threads.

Reconnecting a surviving sandbox reloads the saved ACP session;
a failed load is reported rather than silently starting a new conversation.
Approvals require an explicit choice; Stop cancels the current turn. Signing out
of shared Codex applies to all the user's shared threads and is blocked while any
thread is busy. It does not delete workspaces or conversations. This is separate
from GitHub sign-out. Deleting the last thread does not clear the saved login.

Mode, model, reasoning effort and fast-mode selectors appear only when advertised
by the adapter. They cannot change during a running turn. Model changes refresh
the supported choices. Fast mode may increase usage; it is not a generic speed dial.
Context usage is the last Codex-reported estimate, not billing or subscription
quota. Agent-emitted thinking text is collapsed separately from the final answer.

Use the bell in the workspace header to enable desktop notifications. After
granting browser permission, completed turns and new approval/sign-in requests
notify while the tab is hidden; clicking a notification selects its project and
thread. The preference is saved per account in this browser. No permission prompt
appears until you choose to enable notifications. Blocked permissions must be
changed in browser site settings. HTTPS (or localhost) and a browser supporting
desktop notifications are required.

With notifications enabled, hidden tabs poll the existing activity endpoint every
10 seconds without fetching conversations, renewing workspace presence, or booting
a sandbox. Browser background throttling can delay delivery. Keep the tab open;
this is not push delivery after the tab closes. Initial activity is treated as a
baseline, so old completions and approvals don't generate notifications on reload.

## Development

Use Bun 1.3.10, Node 22.12+ (Vite's Node runtime), Docker Engine and Buildx. Install and run:

```sh
bun install --frozen-lockfile
bun run db:migrate:local
bun run dev
```

In an Amp orb, `.agents/setup` installs locked dependencies.
`amp orb services ensure` starts the supervised dev service and prints the
authenticated review portal. Setup runs without account credentials.

```sh
bun test           # Real Hono + disposable D1: ownership, sessions, CSRF, lost updates
bun run typecheck
bun run lint
bun run build      # Cloudflare Worker + browser production bundles; no deployment
bun run preview    # Local production preview using workerd
```

Keep vinext pinned while evaluating its compatibility.

## Self-hosting on your Cloudflare account

There is no central Agentflare service, shared database or built-in account key.
Each installation owns its Worker, D1 database, OAuth app and secrets. This currently
means self-deployable **on Cloudflare**, not a Docker-only/non-Cloudflare distribution.
Sandbox execution requires a paid Cloudflare account with Containers enabled.
Review `instance_type` and `max_instances` in Wrangler before deploying; the current
limit is five containers per installation, not five per user. Containers incur
charges while running. Only allow trusted users: the CLI can execute arbitrary code
and access the network inside its sandbox.

### Configure identity

1. Choose one canonical origin, with no trailing slash. Use HTTPS outside local
   development. Preview/portal deployments need their actual external origin, not
   the internal port. This origin is the only allowed browser-write origin.
2. Register your own [GitHub App](https://github.com/settings/apps/new).
   Set the homepage to that origin and the callback to
   `<origin>/api/auth/callback/github`. Grant Email addresses: Read-only for sign-in.
   Grant Contents and Pull requests: Read & write, and install on selected
   repositories. The current clone token explicitly narrows Contents to Read-only.
   Leave OAuth-during-installation and webhooks disabled. Use a separate app for local testing.
3. Copy `.dev.vars.example` to `.dev.vars` for local development, then fill:
   - `BETTER_AUTH_URL`: the canonical origin.
   - `BETTER_AUTH_SECRET`: at least 32 random characters; generate with
     `openssl rand -base64 32`. Keep it backed up securely: OAuth tokens are encrypted
     with it. Changing it invalidates sessions and requires OAuth reauthentication.
   - `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`: your GitHub App credentials.
   - `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`: the App's numeric ID and PEM
     private key. Store the PEM in a Worker secret, never source control or a
     container image. `.dockerignore` excludes credentials from the image context.
   - `ALLOWED_GITHUB_IDS`: comma-separated **numeric GitHub account IDs**, not
     usernames. Find your ID with `gh api user --jq .id`. No wildcard or open signup.
4. Run `bun run db:migrate:local`, start the app, and sign in. Until configured,
   the app shows installation instructions and denies private API access.

The allowlist is checked at OAuth admission and on every private API request.
Removing an ID blocks its existing sessions too. GitHub App user tokens are governed
by the app's granted permissions, not OAuth scopes; they are encrypted server-side
and must never be handed to a sandbox. The browser cannot choose sign-in options
or retrieve stored OAuth tokens. Starting a thread verifies the signed-in user's
access first, then the App's installation, then mints a token for only that repository.
The App private key and user OAuth token never enter the sandbox.

### Deploy when ready

These are **operator actions**, not commands run by setup or tests. They create
resources, apply remote migrations and deploy to your account:

1. Authenticate Wrangler to your Cloudflare account.
2. Create your own database with `bunx wrangler d1 create agentflare`. Put the
   returned database ID in `wrangler.jsonc`, replacing the local-only zero UUID.
3. Configure `BETTER_AUTH_URL`, `GITHUB_CLIENT_ID`, `GITHUB_APP_ID` and `ALLOWED_GITHUB_IDS` as Worker
   variables in your Wrangler config. Store `BETTER_AUTH_SECRET` and
   `GITHUB_CLIENT_SECRET` with `bunx wrangler secret put <NAME>`; never in Git.
   Upload the PEM using `bunx wrangler secret put GITHUB_APP_PRIVATE_KEY < /secure/path/app.pem`.
4. Review `migrations/`, back up existing data, then run
   `bunx wrangler d1 migrations apply DB --remote` on the intended account/database.
5. For persistent workspaces, create a private bucket with
   `bunx wrangler r2 bucket create agentflare-workspaces`. Match its name in both
   the `BACKUP_BUCKET` binding and `BACKUP_BUCKET_NAME` variable in the selected
   Wrangler environment. Create R2 S3 credentials with **Object Read & Write**
   access scoped to this bucket only. Upload `R2_ACCESS_KEY_ID` and
   `R2_SECRET_ACCESS_KEY` as Worker secrets, and set `CLOUDFLARE_R2_ACCOUNT_ID` to
   the account containing that bucket (as a variable or Worker secret).
   For the named environment append `--env production` to `wrangler secret put`.
   These credentials are required by Sandbox SDK 0.12.10 for archive upload and
   restore; an R2 Worker binding alone is insufficient. Do not pass them to Codex
   or put them in the Docker image. Checkpoints use `backups/` and
   `runtime-snapshots/`; keep both private and exclude them from expiration rules.
   The SDK requires a finite TTL, so archives use a 100-year expiry and superseded
   archives are removed after a successful replacement. No new D1 migration is
   required for workspace persistence; checkpoint pointers live in the user's DO.
6. Run `bun run build` and `bunx wrangler deploy --config dist/server/wrangler.json`.
   Ensure the chosen domain serves this Worker before testing the OAuth callback.

Local tests use fake storage and disposable data, not the production bucket.
Leave the R2 credential variables empty for ordinary local development. A real
archive integration check needs a separate development bucket with matching
Worker binding and S3 credentials; do not mix locally emulated R2 objects with
production S3 archives. Rebuild the container image with this release.

This repository also includes the operator's `env.production` configuration for
`agentflare.onlychan.xyz`. Other self-hosters must replace its domain, database ID,
Client ID and allowed GitHub IDs with their own; no secrets are committed.
For this named environment, use:

```sh
bunx wrangler d1 migrations apply DB --env production --remote
bun run build:production
bunx wrangler deploy --config dist/server/wrangler.json
```

Upload `BETTER_AUTH_SECRET`, `GITHUB_CLIENT_SECRET` and `GITHUB_APP_PRIVATE_KEY` as Worker secrets for that
environment. A first deployment can supply an owner-only secrets file with
Wrangler's `--secrets-file` option; delete it after uploading. Subsequent deployments
preserve Worker secrets. Never regenerate `BETTER_AUTH_SECRET` on each deploy.
On a memory-constrained orb, stop the dev service before building and restart it
afterwards rather than running development and production builds together.

Keep the database and secret backups private. Use `bun run db:generate` after
schema changes and review generated SQL; never use schema push against production.
Tests create disposable local D1 databases and synthetic sessions. They never call
GitHub, provision Cloudflare resources or add a development authentication bypass.

## Runtime checks and remaining work

The application owns identity, repository access, provisioning and code review.
For Codex it renders structured ACP messages and explicit permission choices;
the adapter and Codex own model/tool execution and native authentication.
Only shared per-user Codex runtimes are supported. Retired per-thread runtime
records are excluded from the API, not silently reopened in a different sandbox.
Historical database migrations and records are retained; this cleanup does not
delete old production containers or their data.

ACP conversations preserve ordered text, image, audio, embedded-resource, and
resource-link blocks in messages and tool output. Agents advertise prompt media
capabilities; unsupported image/audio inputs fall back to embedded context when
available. Attachment-only prompts are supported, with four files and a 2 MB
UTF-8 encoded prompt limit. Rich transcript snapshots are bounded to 8 MB.

The repository UI uses [`@pierre/trees`](https://trees.software/docs) for file
navigation and [`@pierre/diffs`](https://diffs.com/docs) for file/diff rendering.
Both declare Apache-2.0 licensing and React 19 support; Trees is currently beta.
[`DiffsHub`](https://diffshub.com) is a reference UI,
not an embedded service or a destination for users' code/credentials. Git stage
must distinguish working-tree ↔ index from index ↔ HEAD; these libraries do not
perform stage/unstage operations or provide filesystem authorization.

`bun test` uses disposable repositories and D1 databases to check ownership, origins,
path/symlink escapes, literal Git pathspecs, renames, and index versus working-tree
diffs. GitHub token tests mock GitHub, verify the App signature, and ensure user
access denial stops before using App authority.

ACP tests use the real SDK with a scripted subprocess (no provider credentials)
to verify device-login completion, streamed text, deny/allow boundaries, prompt
deduplication, cancellation, process death, and saved-session replay. The container
installs its own pinned ACP dependencies from `sandbox/acp/package-lock.json`.
These tests do not establish real subscription entitlement or live Cloudflare
container connectivity; those need an authenticated end-to-end smoke check.

Still needed: per-user runtime/storage budgets and process-level recovery UX.

**Publishing must be enforced at the credential boundary.** A confirmation button
cannot prevent a native CLI from running `git push` if its sandbox already holds
write credentials. Use read-only repository access in the workspace and a
separate, authorized publishing operation. ACP permissions are not a substitute
for scoped repository credentials.

Sandbox disk is ephemeral. Checkpoint files and supported agent session state;
never promise process-memory recovery or preservation beyond the last checkpoint.
Do not expose preview, clone or execution endpoints until their resource
authorization is enforced. R2 restoration recovers only the last successful save.
Local and production D1 bindings are separate. No deployment command runs during
setup/tests.
