import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["api/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
