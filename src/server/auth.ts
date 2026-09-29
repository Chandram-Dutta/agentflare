import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./db/auth-schema";
import { allowedGitHubIds, type Bindings } from "./env";

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
