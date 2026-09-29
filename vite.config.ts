import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [
    vinext(),
    cloudflare({
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }),
  ],
  server: {
    allowedHosts: process.env.PUBLIC_URL
      ? [new URL(process.env.PUBLIC_URL).hostname]
      : [],
  },
});
