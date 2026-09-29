import type { D1Database } from "@cloudflare/workers-types";

export type Bindings = {
  DB?: D1Database;
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  ALLOWED_GITHUB_IDS?: string;
};

export function allowedGitHubIds(env: Bindings): Set<string> {
  return new Set(
    (env.ALLOWED_GITHUB_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => /^[1-9][0-9]*$/.test(id)),
  );
}

export function installationReady(env: Bindings): boolean {
  if (
    !env.DB ||
    !env.BETTER_AUTH_SECRET ||
    env.BETTER_AUTH_SECRET.length < 32 ||
    !env.GITHUB_CLIENT_ID ||
    !env.GITHUB_CLIENT_SECRET ||
    allowedGitHubIds(env).size === 0
  )
    return false;
  try {
    const url = new URL(env.BETTER_AUTH_URL ?? "");
    return (
      url.origin === env.BETTER_AUTH_URL &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}
