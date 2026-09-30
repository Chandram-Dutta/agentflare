import type { MetadataRoute } from "next";
import { env } from "cloudflare:workers";

export default function sitemap(): MetadataRoute.Sitemap {
  return env.BETTER_AUTH_URL
    ? [{ url: new URL("/", env.BETTER_AUTH_URL).href }]
    : [];
}
