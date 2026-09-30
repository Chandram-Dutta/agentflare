# Agentflare

Terminal-first development workspaces. Choose a repository and coding CLI; use the
agent's native terminal UI instead of a platform-specific chat wrapper.

## Current milestone

A persistent, authenticated workspace with an initial Cloudflare Sandbox runtime:

- Next.js App Router structure on vinext/Vite and Cloudflare Workers.
- TypeScript, Bun, Tailwind, shadcn/ui, and Hono.
- GitHub sign-in through Better Auth; closed-by-default GitHub account allowlist.
- D1/Drizzle projects and threads, private to their owner and saved across reloads.
- Project tabs, per-project threads, a center terminal and a Files/Git stage inspector.
- Monospace light/dark workspace with an xterm.js terminal renderer.
- Server-side ownership checks, exact-origin write protection and stale-edit detection.

Each started thread checks user and GitHub App repository access, clones into its
own sandbox/branch, and opens Claude Code or Codex in a native PTY. xterm.js carries
binary WebSocket input/output and resize messages. Reconnecting attaches to the
same live agent. Files and Git stage use Pierre Trees/Diffs with actual repository
data; use refresh after agent edits. Stage and commit through the CLI.

**Experimental: sandbox disk and agent login state are ephemeral.** After 30 minutes
idle or a container restart they can be lost; saved thread metadata is not a backup.
No R2 checkpoints or publish operation yet. Clone credentials are short-lived and
read-only, not left in Git configuration. Native `git push` requires your own
repository credentials until controlled publishing is implemented. Do not entrust
unexported work to this initial runtime. Authenticate the agent through its native
CLI; browser-local OAuth callbacks may require its remote/device login option.

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
5. Run `bun run build` and `bunx wrangler deploy --config dist/server/wrangler.json`.
   Ensure the chosen domain serves this Worker before testing the OAuth callback.

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

The application owns identity, repository access, credentials, provisioning,
terminal transport, checkpoints and code review. The CLI owns its conversation,
tools, menus and permission prompts. No output parsing is needed to show its UI.

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

For a Docker-backed runtime smoke check, run this **local-only** fixture (never
deploy it):

```sh
bunx wrangler dev --config scripts/runtime-smoke/wrangler.jsonc --port 3900
curl http://localhost:3900/prepare
```

It clones a synthetic local repository and issues concurrent starts against one
Durable Object. `/terminal` upgrades to the native Codex PTY, `/pid` reports its
process, and `/destroy` removes this disposable sandbox. No GitHub/agent tokens
are needed. Run only one dev server on memory-constrained machines. Some nested
sandboxes lack the kernel socket/TPROXY modules required by Wrangler's network
proxy: Docker builds and ordinary containers can work while the full local
Containers runtime cannot. In that case the deployment must be smoke-tested on
Cloudflare; do not treat unit tests as proof of the live PTY path.

To check resize signaling without Wrangler's network proxy:

```sh
docker build -t agentflare-resize:local .
docker run --rm -v "$PWD/scripts/runtime-smoke/pty-resize.ts:/tmp/pty-resize.ts:ro" \
  --entrypoint bun agentflare-resize:local /tmp/pty-resize.ts
```

This checks shrink/grow notifications, exact terminal geometry, and subsequent
input using the image's Bun and agent launcher. The launcher acquires a controlling
terminal so the SDK's pre-created PTY delivers SIGWINCH to the CLI. This is a
local process-level regression check, not a live Cloudflare or agent UI test.

Still needed: R2 checkpoints and restore, encrypted reusable agent credentials,
controlled publishing, agent restart/stop UX, and per-user runtime budgets.

**Publishing must be enforced at the credential boundary.** A confirmation button
cannot prevent a native CLI from running `git push` if its sandbox already holds
write credentials. Use read-only repository access in the workspace and a
separate, authorized publishing operation. Agent permission prompts remain native.

Sandbox disk is ephemeral. Checkpoint files and supported agent session state;
never promise process-memory recovery or preservation beyond the last checkpoint.
Do not expose terminal, preview, clone or execution endpoints until their resource
authorization is enforced. R2 restoration is not implemented yet.
Local and production D1 bindings are separate. No deployment command runs during
setup/tests.
