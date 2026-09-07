import { defineConfig } from "@playwright/test";

const port = 34117;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  webServer: {
    command: `SYNCANDRUN_E2E_PORT=${port} corepack pnpm dlx node@22 node_modules/tsx/dist/cli.mjs tests/e2e/server.ts`,
    url: `http://127.0.0.1:${port}/health/ready`,
    reuseExistingServer: false,
    timeout: 30_000
  }
});
