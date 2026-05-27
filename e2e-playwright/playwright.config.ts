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
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],

  use: {
    baseURL: NAS_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000
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
