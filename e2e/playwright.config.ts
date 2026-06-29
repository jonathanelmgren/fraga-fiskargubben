import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const e2eDir = __dirname;
const repoRoot = path.resolve(e2eDir, "..");

const PORT = Number(process.env.PORT ?? 3110);
const allowReuse = process.env.E2E_REUSE_SERVER === "1";

export default defineConfig({
  testDir: path.join(e2eDir, "specs"),
  outputDir: path.join(e2eDir, ".artifacts", "test-results"),
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [
    ["list"],
    [
      "html",
      {
        outputFolder: path.join(e2eDir, ".artifacts", "report"),
        open: "never",
      },
    ],
  ],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: allowReuse
    ? {
        command: "true",
        url: `http://localhost:${PORT}`,
        reuseExistingServer: true,
        timeout: 120_000,
      }
    : {
        command: `pnpm build && pnpm exec next start --port ${PORT}`,
        url: `http://localhost:${PORT}`,
        cwd: repoRoot,
        reuseExistingServer: false,
        timeout: 240_000,
      },
});
