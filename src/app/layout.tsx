import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agentflare",
  description: "Terminal-first development workspaces for coding agents.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
