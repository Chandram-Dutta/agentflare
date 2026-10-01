import type {
  D1Database,
  DurableObjectNamespace,
  R2Bucket,
} from "@cloudflare/workers-types";
import type { ThreadSandbox } from "./sandbox";

export type Bindings = {
  Sandboxes?: DurableObjectNamespace<ThreadSandbox>;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  DB?: D1Database;
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  ALLOWED_GITHUB_IDS?: string;
  HOSTED_MODE?: string;
  UNLIMITED_GITHUB_IDS?: string;
  BACKUP_BUCKET?: R2Bucket;
  BACKUP_BUCKET_NAME?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  CLOUDFLARE_R2_ACCOUNT_ID?: string;
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
    !env.GITHUB_CLIENT_SECRET
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

export function githubAccountAllowed(env: Bindings, id: string): boolean {
  return (
    env.HOSTED_MODE === "true" ||
    !(env.ALLOWED_GITHUB_IDS ?? "").trim() ||
    allowedGitHubIds(env).has(id)
  );
}
