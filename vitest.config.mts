import react from "@vitejs/plugin-react";
import { defineConfig, mergeConfig } from "vitest/config";
import { sharedVitestConfig } from "./vitest.shared";

export default mergeConfig(
  sharedVitestConfig,
  defineConfig({
    plugins: [react()],
    test: {
      environment: "jsdom",
      setupFiles: ["./vitest.setup.ts"],
      passWithNoTests: true,
      exclude: [
        "e2e/**",
        "node_modules/**",
        "dist/**",
        ".next/**",
        ".claude/**",
      ],
    },
  }),
);
