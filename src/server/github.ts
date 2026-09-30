import { createSign } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import type { Bindings } from "./env";

export async function github(
  path: string,
  token: string,
  body?: object,
  method?: string,
  missingOk = false,
) {
  const response = await fetch(`https://api.github.com${path}`, {
    method: method ?? (body ? "POST" : "GET"),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agentflare",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    // Workers does not implement redirect: "error". Reject 3xx below instead
    // of following redirects with GitHub credentials.
    redirect: "manual",
  });
  if (missingOk && response.status === 404) return null;
  if (response.status === 409 || response.status === 422)
    throw new HTTPException(409, {
      message:
        "GitHub rejected the publish. The branch may have changed, the PR may be closed, or repository rules may block it. Refresh before retrying.",
    });
  if (!response.ok)
    throw new HTTPException(
      response.status === 404 || response.status === 403 ? 403 : 502,
      {
        message:
          "GitHub denied repository access. Install the GitHub App on this repository and reauthorize your account.",
      },
    );
  return response.status === 204 ? null : response.json();
}

export async function repositoryCloneToken(
  env: Bindings,
  repository: string,
  userToken: string,
): Promise<string> {
  return repositoryToken(env, repository, userToken, false);
}

export async function repositoryWriteToken(
  env: Bindings,
  repository: string,
  userToken: string,
): Promise<string> {
  return repositoryToken(env, repository, userToken, true);
}

async function repositoryToken(
  env: Bindings,
  repository: string,
  userToken: string,
  write: boolean,
): Promise<string> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY)
    throw new HTTPException(503, {
      message: "The operator must configure the GitHub App ID and private key.",
    });
  const path = repository.slice("https://github.com/".length);
  // User access and App installation access must BOTH include this repository.
  const repo = (await github(`/repos/${path}`, userToken)) as {
    id: number;
    permissions?: { push?: boolean };
  };
  if (write && repo.permissions?.push !== true)
    throw new HTTPException(403, {
      message:
        "Your GitHub account needs write access to publish this repository.",
    });
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: env.GITHUB_APP_ID, iat: now - 60, exp: now + 300 })}`;
  const signature = createSign("RSA-SHA256")
    .update(payload)
    .sign(env.GITHUB_APP_PRIVATE_KEY)
    .toString("base64url");
  const jwt = `${payload}.${signature}`;
  const installation = (await github(`/repos/${path}/installation`, jwt)) as {
    id: number;
  };
  const result = (await github(
    `/app/installations/${installation.id}/access_tokens`,
    jwt,
    {
      repository_ids: [repo.id],
      permissions: write
        ? { contents: "write", pull_requests: "write" }
        : { contents: "read" },
    },
  )) as { token: string };
  return result.token;
}
