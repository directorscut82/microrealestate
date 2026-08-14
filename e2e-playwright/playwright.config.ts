import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

const TEST_ACCOUNT_FILE = path.resolve(__dirname, '../.secrets/cypress-test-account');
let testAccount: Record<string, string> = {};
if (fs.existsSync(TEST_ACCOUNT_FILE)) {
  testAccount = dotenv.parse(fs.readFileSync(TEST_ACCOUNT_FILE));
}

// Trailing slash matters: Playwright resolves relative paths against the
// baseURL using the URL() constructor. Without the slash, `goto('signin')`
// would replace the `/landlord` segment instead of appending under it.
const NAS_BASE_URL = process.env.LANDLORD_APP_URL || 'http://192.168.0.96:1350/landlord/';
const NAS_GATEWAY_URL = process.env.GATEWAY_URL || 'http://192.168.0.96:1350';

process.env.TEST_EMAIL = testAccount.EMAIL || '';
process.env.TEST_PASSWORD = testAccount.PASSWORD || '';
process.env.TEST_ORG_NAME = testAccount.ORG_NAME || '';
process.env.TEST_LOCALE = testAccount.LOCALE || '';
process.env.TEST_CURRENCY = testAccount.CURRENCY || '';
process.env.NAS_GATEWAY_URL = NAS_GATEWAY_URL;

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  // The PER-TEST budget, and it is the one that actually bit. Playwright's default is
  // 30s and it bounds the whole test INCLUDING its hooks — `test.setTimeout` is not
  // inherited by a beforeEach, which is a trap already recorded in this repo's steering
  // docs. So raising navigationTimeout alone was not enough: a cold signin inside
  // beforeEach still died at 30s with «Test timeout exceeded while running "beforeEach"».
  //
  // 120s is the cold-route latency (8-14s, measured) plus the app's own work, with room
  // for the multi-step specs. Individual specs that need more still say so locally
  // (43.2 sets 360s for nine allocation round-trips).
  timeout: 120_000,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],

  use: {
    baseURL: NAS_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    // MEASURED, not guessed. This suite runs against a NAS, and a Next.js route that has
    // not been hit since the containers restarted takes 8-14s to serve (curl, 2026-08-14:
    // signin 10.3s / 14.2s / 8.1s cold, then 0.12s warm). 119 of the 157 specs' goto
    // calls use the default waitUntil:'load', which waits for every subresource on top of
    // that — so 30s left no headroom and 8 specs failed on navigation alone while their
    // pages were visibly rendered. Every one of them passed warm, unchanged.
    //
    // Raised HERE rather than by rewriting 119 call sites and 452 waitForTimeout sleeps:
    // the measured cause is latency, not a wrong wait condition, and a blanket rewrite of
    // sleeps that currently pass would risk the ones that are load-bearing for a debounce
    // or an animation. If a route ever genuinely hangs, this budget still fails it.
    navigationTimeout: 90_000
  },

  projects: [
    {
      name: 'chromium',
      // Larger-than-default viewport — the landlord app's edit dialogs are
      // tall (unit form has ~12 inputs) and at the default 1280x720 the
      // submit button falls below the dialog's internal scroll container.
      // Match what a realistic landlord workstation would see.
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1200 } }
    }
  ]
});
