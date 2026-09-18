import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    globals: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
