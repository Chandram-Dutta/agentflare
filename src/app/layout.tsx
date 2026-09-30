import type { Metadata, Viewport } from "next";
import { env } from "cloudflare:workers";
import { Providers } from "./providers";
import "./globals.css";

export function generateMetadata(): Metadata {
  const title = "Agentflare — A workspace for coding agents";
  const description =
    "An open-source, self-hostable workspace for coding agents. Connect a GitHub repository, work with Codex, review changes, and open pull requests.";
  return {
    metadataBase: env.BETTER_AUTH_URL
      ? new URL(env.BETTER_AUTH_URL)
      : undefined,
    applicationName: "Agentflare",
    title: { default: title, template: "%s | Agentflare" },
    description,
    openGraph: {
      type: "website",
      siteName: "Agentflare",
      locale: "en_US",
      title,
      description,
      images: [
        {
          url: "/social-preview.png",
          width: 1200,
          height: 630,
          alt: "Agentflare — A workspace for you and your coding agents. Run agents. Review changes. Ship code.",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["/social-preview.png"],
    },
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f5f0" },
    { media: "(prefers-color-scheme: dark)", color: "#1c1d1a" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
