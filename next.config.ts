import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "pdf-parse", "jsdom", "@mozilla/readability"],
};

export default nextConfig;