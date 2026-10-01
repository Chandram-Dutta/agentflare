# Self-hosting

[README](../README.md) · [Architecture](architecture.md)

Agentflare currently runs on Cloudflare, not as a standalone Docker deployment.
Your installation owns its Worker, D1 database, Durable Objects, containers,
GitHub App, secrets, and optional R2 storage. No central Agentflare account key
is required.

## Requirements

- A paid Cloudflare account with Containers enabled and a domain for the app.
- Bun 1.3.10, Node.js 22.12+, Docker Engine, and Docker Buildx.
- A GitHub account able to create an App and install it on the desired repositories.

Review container sizing and costs before opening signup. The checked-in pool is
five `standard-1` containers **per installation**, not per user. Each user's agent
can execute arbitrary code and access the network. Project quotas do not cap costs.

## Register a GitHub App

Choose a canonical HTTPS origin without a trailing slash, then
[create a GitHub App](https://github.com/settings/apps/new):

| Setting | Value |
| --- | --- |
| Homepage | Your canonical origin |
| Callback | `<origin>/api/auth/callback/github` |
| Setup URL (recommended) | `<origin>/connect/github` |
| Account permission | Email addresses: read-only |
| Repository permissions | Contents: read/write; Pull requests: read/write |
| Webhooks | Disabled |
| Request user authorization during installation | Disabled |

Make the GitHub App **public** if other accounts will use this installation.
This does not make their repositories public. A private App cannot onboard other
accounts even when Agentflare itself allows signup.

After GitHub sign-in, Agentflare checks for an accessible, non-suspended
installation of your App. Users without one are guided to install it in a new
tab, then return to continue automatically after verification. Organization
approval requests must be approved first. The setup URL returns the installation
tab to verification; without it, return to the original Agentflare tab manually.
No webhook is required. Keep **Request user authorization (OAuth) during
installation disabled**: sign-in has already completed OAuth, and starting it
again from installation has no Agentflare-issued state. Do not use the OAuth
callback as the setup URL; they serve different flows.

Generate a client secret and a PEM private key. Install the App on selected
repositories. Users need both their own repository access and an App installation;
the App alone does not grant a user access. Approve new installation permissions
if you change the App later. Use a separate App for local development.

## Configure your installation

[`wrangler.jsonc`](../wrangler.jsonc) contains a base development configuration
and the hosted operator's `env.production`. **Do not deploy the production block
unchanged.** Replace the Worker name, domain route, database ID, bucket names,
GitHub IDs, and admission settings with your own.

This guide uses the named `production` environment. Configure its bindings and
variables explicitly; do not assume the base environment's values are inherited.

| Variable | Purpose |
| --- | --- |
| `BETTER_AUTH_URL` | Canonical public origin; also used for browser-write checks |
| `GITHUB_CLIENT_ID` | GitHub App client ID |
| `GITHUB_APP_ID` | Numeric GitHub App ID |
| `ALLOWED_GITHUB_IDS` | Optional private-admission list; see below |

Store these as Worker **secrets**, not Wrangler variables or committed files:

| Secret | Purpose |
| --- | --- |
| `BETTER_AUTH_SECRET` | At least 32 random characters; generate with `openssl rand -base64 32` |
| `GITHUB_CLIENT_SECRET` | GitHub App client secret |
| `GITHUB_APP_PRIVATE_KEY` | Full PEM private key |

Keep `BETTER_AUTH_SECRET` stable and backed up securely: it protects sessions,
OAuth credentials, and saved Codex authentication. Rotating it requires planning
for reauthentication. No operator OpenAI secret is needed; users sign into Codex
with their own ChatGPT accounts.

### Access

| Configuration | Admission | Project/thread quotas |
| --- | --- | --- |
| Default, no allowlist | Any GitHub account | None |
| Nonempty `ALLOWED_GITHUB_IDS` | Listed GitHub IDs only | None |

Lists are comma-separated **numeric GitHub account IDs**, not usernames or emails.
Find your ID with `gh api user --jq .id`. A malformed nonempty admission list fails
closed. The list is checked at login and on private requests,
so removing an ID also blocks existing sessions. Clearing the list reopens access.

The checked-in production configuration contains the operator's allowlist. Remove
it for open signup or replace it with your own IDs for private access. Hosted
quota settings belong to `feat/hosted-account-limits` and are not supported on
`main`.

## Provision and deploy

These commands modify your Cloudflare account. Authenticate Wrangler to the
intended account first, and review configuration before running them.

```sh
bun install --frozen-lockfile
bunx wrangler login
bunx wrangler d1 create agentflare
```

Put the returned database ID in `env.production.d1_databases` with binding `DB`.
Configure your domain route and variables, then upload secrets interactively:

```sh
bunx wrangler secret put BETTER_AUTH_SECRET --env production
bunx wrangler secret put GITHUB_CLIENT_SECRET --env production
bunx wrangler secret put GITHUB_APP_PRIVATE_KEY --env production < /secure/path/app.pem
```

Review [`migrations`](../migrations) and back up an existing database before applying:

```sh
bunx wrangler d1 migrations apply DB --env production --remote
```

### Enable workspace persistence

Create a private bucket for this installation:

```sh
bunx wrangler r2 bucket create agentflare-workspaces
```

Set the production `BACKUP_BUCKET` R2 binding and `BACKUP_BUCKET_NAME` variable to
that bucket name. Set `CLOUDFLARE_R2_ACCOUNT_ID` to the bucket's account ID. Create
R2 S3 credentials with **Object Read & Write** access scoped to this bucket, then:

```sh
bunx wrangler secret put R2_ACCESS_KEY_ID --env production
bunx wrangler secret put R2_SECRET_ACCESS_KEY --env production
```

The Sandbox SDK requires S3 credentials for archives; the Worker binding alone
is insufficient. Never embed these credentials in the image or give them to Codex.
Keep `backups/` and `runtime-snapshots/` private and free of expiration lifecycle
rules. They can contain source code and secrets written into workspaces.

Persistence is optional, but the checked-in configuration declares the R2 binding.
If omitting it, remove that binding and its related variables from your selected
environment rather than leaving a reference to a nonexistent bucket. Without full
persistence configuration, the UI reports workspace saving as disabled.

### Build and release

```sh
bun test
bun run typecheck
bun run lint
bun run build:production
bunx wrangler deploy --config dist/server/wrangler.json
```

Deploy the generated configuration, which contains the built Worker and assets.
Docker must be available for the container build. Subsequent deployments preserve
Worker secrets; do not regenerate the auth secret on each release. If deliberately
using the base environment instead, use `bun run build` and omit `--env production`
from migration and secret commands.

Verify the domain serves your Worker before testing the GitHub callback. Check
`/api/health`, then sign in, create a project and thread, authenticate Codex, run a
turn, inspect changes, and publish a test draft PR. Confirm the Cloudflare container
rollout succeeds; a successful Worker upload alone does not prove runtime health.
For persistence, allow an idle checkpoint to finish and verify a resumed workspace.

## Local development

```sh
cp .dev.vars.example .dev.vars
bun install --frozen-lockfile
bun run db:migrate:local
bun run dev
```

Fill `.dev.vars` with your local GitHub App credentials and auth secret before
signing in. Use the actual development origin for `BETTER_AUTH_URL` and the App
callback. A portal needs its external origin, not the internal port. Keep the PEM
quoted as a multiline value. `.dev.vars` is ignored; never commit it or the PEM.
Until identity is configured the app displays installation instructions.

Leave R2 credentials empty for ordinary local development and tests. Real archive
tests need a separate development bucket with matching binding and S3 credentials;
do not combine emulated R2 objects with production S3 archives.

In an Amp orb, `.agents/setup` installs dependencies and `amp orb services ensure`
starts the configured supervised service and prints its review portal. Setup and
tests do not provision remote resources. On a small machine, stop the dev service
before building to avoid running both workloads at once.

## Operations and troubleshooting

- **Installation setup required:** check D1 binding, canonical origin, GitHub App
  variables, and required Worker secrets in the environment you deployed.
- **Repository access denied:** verify the user's access, the App installation's
  selected repositories, and accepted Contents/PR permissions, then reauthorize.
- **Runtime failure:** retain the displayed error reference and correlate it with
  Worker/runtime logs (`bunx wrangler tail --env production`). Check container
  capacity and rollout state before retrying. Do not publish credentials or raw logs.
- **Workspace saving disabled or failed:** check the R2 binding, matching bucket
  name/account, and bucket-scoped S3 credentials. Visible activity defers full
  archives; saved conversation history does not imply files have been archived.
- **Codex asks for login again:** authorization can expire or be revoked. Enable
  device-code authorization in ChatGPT settings if OpenAI requires it.

Back up D1 and retain private R2 data and the stable auth secret. Changes outside
`/workspace` and running processes are not recoverable. See the
[persistence guarantees](architecture.md#checkpoint-recovery) before relying on
checkpoints. Schema changes use `bun run db:generate` followed by SQL review;
never use an unreviewed schema push against production.
