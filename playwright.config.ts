import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./browser-tests",
  workers: 2,
  use: {
    baseURL: "http://127.0.0.1:5179",
    browserName: "chromium",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 5179 --strictPort",
    url: "http://127.0.0.1:5179",
    reuseExistingServer: !process.env.CI,
  },
});
