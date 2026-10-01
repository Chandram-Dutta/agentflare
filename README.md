# Agentflare

A browser workspace for coding with Codex. Connect a GitHub repository, work with
an agent, review the changes, and publish a draft pull request—all in one place.

[Use Agentflare](https://agentflare.onlychan.xyz) ·
[Self-hosting guide](docs/self-hosting.md) ·
[Architecture](docs/architecture.md)

## What you can do

- Organize work into projects and independent thread checkouts.
- Use Codex through the Agent Client Protocol (ACP), with your ChatGPT login shared
  across your projects and threads.
- Review files, working-tree changes, and branch-wide diffs in resizable panels.
- Publish changes as a commit and draft GitHub PR, then update that PR as you work.
- Return to saved conversations and restore workspace checkpoints when R2 is configured.
- Receive opt-in desktop notifications when a turn finishes or needs attention.

**Agentflare is in alpha.** Current agent support is Codex. Persistence restores
the last successful checkpoint, not running processes; recent unsaved work can be
lost if a container fails. Browser notifications are best-effort and require an
open tab.

## Get started

1. Sign in with GitHub and install the Agentflare GitHub App on your repository.
2. Create a project and thread, then start its workspace.
3. Choose **Sign in with ChatGPT** and complete Codex's device-code login.
4. Work with Codex, review **Changes**, and choose **Create draft PR**.

Self-hosted installations accept GitHub accounts without project or thread quotas
by default; private admission is optional. The hosted service's quota policy is
maintained separately on `feat/hosted-account-limits`, not on `main`.
See [access configuration](docs/self-hosting.md#access).

## Run locally

Requires Bun 1.3.10, Node.js 22.12+, Docker Engine, and Docker Buildx.
Configure your own GitHub App and local environment using the
[self-hosting guide](docs/self-hosting.md#local-development), then run:

```sh
bun install --frozen-lockfile
bun run db:migrate:local
bun run dev
```

```sh
bun test
bun run typecheck
bun run lint
bun run build
```

Tests use disposable data and mocked external services. They do not deploy
infrastructure or verify real GitHub/Codex credentials.

## Stack

TypeScript, Bun, vinext (Next.js App Router on Vite), React, Tailwind CSS, shadcn/ui,
and Hono. Cloudflare Workers serve the app; D1 stores account and project data,
Durable Objects coordinate per-user runtimes, Containers run Codex, and R2 stores
workspace checkpoints. File navigation and diffs use Pierre Trees and Diffs.

Agentflare currently self-hosts on **Cloudflare**, not as a standalone Docker app.
See the [architecture guide](docs/architecture.md) for runtime ownership, security
boundaries, and persistence guarantees.
