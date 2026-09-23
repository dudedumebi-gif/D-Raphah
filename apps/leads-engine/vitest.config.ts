import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["server/**/*.test.ts", "tests/**/*.test.ts"],
    coverage: {
      include: ["server/domain.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
  },
});
