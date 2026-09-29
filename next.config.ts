import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: process.env.PUBLIC_URL
    ? [new URL(process.env.PUBLIC_URL).hostname]
    : [],
};

export default nextConfig;
