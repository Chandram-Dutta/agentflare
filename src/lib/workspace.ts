import { z } from "zod";

export const agents = {
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

export const projectInput = z.strictObject({
  name: z.string().trim().min(1).max(40),
  repository,
});

export const threadInput = z.strictObject({
  name: z.string().trim().min(1).max(60),
  agent: z.literal("codex"),
});

export const projectUpdate = projectInput.extend({
  version: z.number().int().positive(),
});
export const threadUpdate = threadInput.extend({
  version: z.number().int().positive(),
});

export type Project = z.infer<typeof projectInput> & {
  id: string;
  version: number;
  createdAt: number;
};
export type Thread = z.infer<typeof threadInput> & {
  id: string;
  runtime: "user" | "computer";
  projectId: string;
  version: number;
  createdAt: number;
};
export type WorkspaceData = { projects: Project[]; threads: Thread[] };
