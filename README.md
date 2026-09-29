# Agentflare

Terminal-first development workspaces. Choose a repository and coding CLI; use the
agent's native terminal UI instead of a platform-specific chat wrapper.

## Current milestone

A persistent, authenticated workspace, **not a hosted agent runner yet**:

- Next.js App Router structure on vinext/Vite and Cloudflare Workers.
- TypeScript, Bun, Tailwind, shadcn/ui, and Hono.
- GitHub sign-in through Better Auth; closed-by-default GitHub account allowlist.
- D1/Drizzle projects and threads, private to their owner and saved across reloads.
- Project tabs, per-project threads, a center terminal and a Files/Git stage inspector.
- Monospace light/dark workspace with a Ghostty terminal renderer.
- Server-side ownership checks, exact-origin write protection and stale-edit detection.

The views show disconnected states, not fabricated files or agent output. No agent
is installed in a sandbox, no shell is connected, and agent credentials are not
collected yet. Repository URLs are validated, not cloned or checked for access.

## Development

Use Bun 1.3.10 and Node 22.12+ (Vite's Node runtime). Install and run:

```sh
bun install --frozen-lockfile
bun run db:migrate:local
bun run dev
```

In an Amp orb, `.agents/setup` installs locked dependencies and prepares the WASM
asset. `amp orb services ensure` starts the supervised dev service and prints the
authenticated review portal. Setup runs without account credentials.

```sh
bun test           # Real Hono + disposable D1: ownership, sessions, CSRF, lost updates
bun run typecheck
bun run lint
bun run build      # Cloudflare Worker + browser production bundles; no deployment
bun run preview    # Local production preview using workerd
```

`postinstall` copies Ghostty's packaged WASM into `public/`; never commit that
generated binary. Keep vinext pinned while evaluating its compatibility.

## Self-hosting on your Cloudflare account

There is no central Agentflare service, shared database or built-in account key.
Each installation owns its Worker, D1 database, OAuth app and secrets. This currently
means self-deployable **on Cloudflare**, not a Docker-only/non-Cloudflare distribution.
Sandbox execution and its billable resources are not enabled yet.

### Configure identity

1. Choose one canonical origin, with no trailing slash. Use HTTPS outside local
   development. Preview/portal deployments need their actual external origin, not
   the internal port. This origin is the only allowed browser-write origin.
2. Register your own [GitHub App](https://github.com/settings/apps/new).
   Set the homepage to that origin and the callback to
   `<origin>/api/auth/callback/github`. Grant Email addresses: Read-only for sign-in.
   For future repository publishing, grant Contents and Pull requests: Read & write,
   and install on selected repositories. Leave OAuth-during-installation and webhooks
   disabled until the repository connection is implemented. Use a separate app for local testing.
3. Copy `.dev.vars.example` to `.dev.vars` for local development, then fill:
   - `BETTER_AUTH_URL`: the canonical origin.
   - `BETTER_AUTH_SECRET`: at least 32 random characters; generate with
     `openssl rand -base64 32`. Keep it backed up securely: OAuth tokens are encrypted
     with it. Changing it invalidates sessions and requires OAuth reauthentication.
   - `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`: your GitHub App credentials.
   - `ALLOWED_GITHUB_IDS`: comma-separated **numeric GitHub account IDs**, not
     usernames. Find your ID with `gh api user --jq .id`. No wildcard or open signup.
4. Run `bun run db:migrate:local`, start the app, and sign in. Until configured,
   the app shows installation instructions and denies private API access.

The allowlist is checked at OAuth admission and on every private API request.
Removing an ID blocks its existing sessions too. GitHub App user tokens are governed
by the app's granted permissions, not OAuth scopes; they are encrypted server-side
and must never be handed to a sandbox. The browser cannot choose sign-in options
or retrieve stored OAuth tokens. GitHub App installation authorization is a separate,
not-yet-implemented integration; login alone never grants clone or push access.

### Deploy when ready

These are **operator actions**, not commands run by setup or tests. They create
resources, apply remote migrations and deploy to your account:

1. Authenticate Wrangler to your Cloudflare account.
2. Create your own database with `bunx wrangler d1 create agentflare`. Put the
   returned database ID in `wrangler.jsonc`, replacing the local-only zero UUID.
3. Configure `BETTER_AUTH_URL`, `GITHUB_CLIENT_ID` and `ALLOWED_GITHUB_IDS` as Worker
   variables in your Wrangler config. Store `BETTER_AUTH_SECRET` and
   `GITHUB_CLIENT_SECRET` with `bunx wrangler secret put <NAME>`; never in Git.
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

Upload `BETTER_AUTH_SECRET` and `GITHUB_CLIENT_SECRET` as Worker secrets for that
environment. A first deployment can supply an owner-only secrets file with
Wrangler's `--secrets-file` option; delete it after uploading. Subsequent deployments
preserve Worker secrets. Never regenerate `BETTER_AUTH_SECRET` on each deploy.
On a memory-constrained orb, stop the dev service before building and restart it
afterwards rather than running development and production builds together.

Keep the database and secret backups private. Use `bun run db:generate` after
schema changes and review generated SQL; never use schema push against production.
Tests create disposable local D1 databases and synthetic sessions. They never call
GitHub, provision Cloudflare resources or add a development authentication bypass.

## Next implementation boundary

The application owns identity, repository access, credentials, provisioning,
terminal transport, checkpoints and code review. The CLI owns its conversation,
tools, menus and permission prompts. No output parsing is needed to show its UI.

The repository UI will use [`@pierre/trees`](https://trees.software/docs) for file
navigation and [`@pierre/diffs`](https://diffs.com/docs) for file/diff rendering.
Both declare Apache-2.0 licensing and React 19 support; Trees is currently beta.
Install and pin them when real repository data is available, not to render fake
files in disconnected panes. [`DiffsHub`](https://diffshub.com) is a reference UI,
not an embedded service or a destination for users' code/credentials. Git stage
must distinguish working-tree ↔ index from index ↔ HEAD; these libraries do not
perform stage/unstage operations or provide filesystem authorization.

1. GitHub App with selected-repository access. Sign-in, sessions and D1 project/thread
   persistence are implemented; real OAuth callback validation still needs operator credentials.
2. One Cloudflare Sandbox per thread/branch; a Durable Object coordinates
   lifecycle. Versioned images preinstall supported CLIs. Start their interactive
   entrypoint in a PTY, not a headless prompt execution mode.
3. Authenticated WebSocket transport for binary PTY input/output and resize
   messages. A browser disconnect must not kill the agent. Reconnect attaches to
   the same live PTY; a lost container requires restoration and a new process.
4. Encrypted bring-your-own credentials, repository-scoped short-lived GitHub
   tokens, and R2 checkpoints excluding credentials and dependency directories.
5. Git diff review and controlled publishing. Runtime and concurrency budgets.

**Publishing must be enforced at the credential boundary.** A confirmation button
cannot prevent a native CLI from running `git push` if its sandbox already holds
write credentials. Use read-only repository access in the workspace and a
separate, authorized publishing operation. Agent permission prompts remain native.

Sandbox disk is ephemeral. Checkpoint files and supported agent session state;
never promise process-memory recovery or preservation beyond the last checkpoint.
Do not expose terminal, preview, clone or execution endpoints until their resource
authorization is enforced. R2 and Sandbox integrations are not implemented yet.
Local and production D1 bindings are separate. No deployment command runs during
setup/tests.
