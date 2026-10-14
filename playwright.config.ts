import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./browser-tests",
  workers: 2,
  use: {
    browserName: "chromium",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "domain-root", use: { baseURL: "http://127.0.0.1:5179/" } },
    {
      name: "github-project-path",
      use: { baseURL: "http://127.0.0.1:5180/mh-wilds-optimizer/" },
    },
  ],
  webServer: [
    {
      command:
        "node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 5179 --strictPort",
      url: "http://127.0.0.1:5179",
      reuseExistingServer: !process.env.CI,
    },
    {
      command:
        "node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 5180 --strictPort --base /mh-wilds-optimizer/",
      url: "http://127.0.0.1:5180/mh-wilds-optimizer/",
      reuseExistingServer: !process.env.CI,
    },
  ],
});
