# Agentflare

Terminal-first development workspaces. Choose a repository and coding CLI; use the
agent's native terminal UI instead of a platform-specific chat wrapper.

## Current milestone

A local foundation, **not a hosted agent runner yet**:

- Next.js App Router structure on vinext/Vite and Cloudflare Workers.
- TypeScript, Bun, Tailwind, shadcn/ui, and Hono.
- Ghostty WASM renderer with ANSI output, keyboard-input diagnostics, and resizing.
- Side-effect-free repository/agent configuration validation. No clone or launch.

The terminal displays labelled sample output. No agent is installed in a sandbox,
no shell is connected, and no user credentials are collected. Configuration is
not saved. The validation endpoint checks format, not repository existence/access.

## Development

Use Bun 1.3.10 and Node 22.12+ (Vite's Node runtime). Install and run:

```sh
bun install --frozen-lockfile
bun run dev
```

In an Amp orb, `.agents/setup` installs locked dependencies and prepares the WASM
asset. `amp orb services ensure` starts the supervised dev service and prints the
authenticated review portal. Setup runs without account credentials.

```sh
bun test           # Real Hono requests: unsafe URLs, command injection, body limits
bun run typecheck
bun run lint
bun run build      # Cloudflare Worker + browser production bundles; no deployment
bun run preview    # Local production preview using workerd
```

`postinstall` copies Ghostty's packaged WASM into `public/`; never commit that
generated binary. Keep vinext pinned while evaluating its compatibility.

## Next implementation boundary

The application owns identity, repository access, credentials, provisioning,
terminal transport, checkpoints and code review. The CLI owns its conversation,
tools, menus and permission prompts. No output parsing is needed to show its UI.

1. GitHub sign-in and a GitHub App with selected-repository access. D1/Drizzle for
   users, projects and workspaces. Better Auth handles application sessions.
2. One Cloudflare Sandbox per workspace/branch; a Durable Object coordinates
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
Do not expose terminal, preview, clone or execution endpoints until authentication
and workspace authorization are enforced. R2, D1 and Sandbox resources are planned,
not provisioned by this scaffold. No deployment command runs during setup/tests.
