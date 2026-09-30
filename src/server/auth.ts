import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import * as schema from "./db/auth-schema";
import { allowedGitHubIds, installationReady, type Bindings } from "./env";

export type Viewer = { id: string; name: string };

// Shared by page rendering and API authorization. A cookie alone is not proof
// of access: verify the database session and the current installation allowlist.
export async function getViewer(
  env: Bindings,
  headers: Headers,
): Promise<{
  configured: boolean;
  user: Viewer | null;
  denied?: boolean;
}> {
  if (!installationReady(env)) return { configured: false, user: null };
  const session = await createAuth(env).api.getSession({ headers });
  if (!session) return { configured: true, user: null };
  const identity = await drizzle(env.DB!)
    .select({ id: schema.account.accountId })
    .from(schema.account)
    .where(
      and(
        eq(schema.account.userId, session.user.id),
        eq(schema.account.providerId, "github"),
      ),
    )
    .get();
  if (!identity || !allowedGitHubIds(env).has(identity.id))
    return { configured: true, user: null, denied: true };
  return {
    configured: true,
    user: { id: session.user.id, name: session.user.name },
  };
}

export function createAuth(env: Bindings) {
  const allowed = allowedGitHubIds(env);
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.BETTER_AUTH_URL!],
    database: drizzleAdapter(drizzle(env.DB!, { schema }), {
      provider: "sqlite",
      schema,
    }),
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID!,
        clientSecret: env.GITHUB_CLIENT_SECRET!,
      },
    },
    user: {
      validateUserInfo({ source }) {
        if (
          source.oauth?.providerId !== "github" ||
          !allowed.has(String(source.oauth.profile?.id))
        ) {
          return {
            error: "access_denied",
            errorDescription:
              "This GitHub account is not allowed on this installation.",
          };
        }
      },
    },
    account: { encryptOAuthTokens: true, accountLinking: { enabled: false } },
    // No cookie cache: a revoked session must stop authorizing API requests.
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    rateLimit: { enabled: true, storage: "database" },
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
  });
}
