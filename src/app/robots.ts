import type { MetadataRoute } from "next";
import { env } from "cloudflare:workers";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/workspace", "/api/"] },
    sitemap: env.BETTER_AUTH_URL
      ? new URL("/sitemap.xml", env.BETTER_AUTH_URL).href
      : undefined,
  };
}
