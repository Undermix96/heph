import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests (phase 4 group C, D55, D56): the real server built from this
 * checkout, a fresh temporary data dir and invented data seeded by e2e/global-setup.ts.
 * Run with `npm run build && npm run e2e`.
 */
export const E2E = {
  uiPort: 18380,
  agentPort: 18381,
  dataDir: path.resolve('.e2e-data'),
  stateFile: path.resolve('.e2e-data/state.json'),
  tokenFile: path.resolve('.e2e-data/token.txt'),
};

export default defineConfig({
  testDir: 'e2e',
  outputDir: '.e2e-data/results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: `http://localhost:${E2E.uiPort}`,
    storageState: E2E.stateFile,
    locale: 'it-IT',
    timezoneId: 'Europe/Rome',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
      testIgnore: /phone\.spec\.ts/,
    },
    {
      name: 'phone',
      use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } },
      testMatch: /(a11y|screens|phone)\.spec\.ts/,
    },
  ],
  webServer: {
    command: 'node apps/server/dist/main.mjs',
    url: `http://localhost:${E2E.uiPort}/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      HEPH_DATA_DIR: E2E.dataDir,
      HEPH_WEB_DIR: 'apps/web/dist',
      HEPH_UI_PORT: String(E2E.uiPort),
      HEPH_AGENT_PORT: String(E2E.agentPort),
      HEPH_LOG_LEVEL: 'warn',
    },
  },
});
