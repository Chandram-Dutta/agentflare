import { z } from "zod";

export const agents = {
  claude: { name: "Claude Code", command: "claude", description: "Anthropic" },
  codex: { name: "Codex", command: "codex", description: "OpenAI" },
} as const;

export type AgentId = keyof typeof agents;

// Accept repository roots only, never arbitrary clone URLs, credentials or flags.
const repository = z
  .string()
  .trim()
  .max(240)
  .regex(
    /^https:\/\/github\.com\/[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_][a-zA-Z0-9_.-]*\/?$/,
    "Use a GitHub repository URL, without credentials, query parameters or a subpath.",
  )
  .transform((value) => value.replace(/\/$/, "").replace(/\.git$/, ""));

export const workspaceConfig = z.strictObject({
  repository,
  agent: z.enum(["claude", "codex"]),
});
