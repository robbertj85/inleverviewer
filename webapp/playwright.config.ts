import { defineConfig, devices } from '@playwright/test';

/**
 * Tests run against a production build, not `next dev`.
 *
 * That is deliberate: the things most likely to break in this app are the
 * security headers and the on-disk data reads in the API routes, and neither
 * behaves the same in dev. `next build` is assumed to have run already —
 * `npm test` chains it.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],

  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  webServer: {
    command: 'npm start',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
