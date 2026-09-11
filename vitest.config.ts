import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // forks : fiabilité avec le module natif better-sqlite3
    pool: "forks",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
    },
  },
});