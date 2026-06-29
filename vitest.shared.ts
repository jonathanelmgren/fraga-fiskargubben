import { defineConfig } from "vitest/config";

export const sharedVitestConfig = defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
});
