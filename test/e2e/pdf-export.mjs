/**
 * PDF Export smoke test — run via /test-prod
 *
 * Requires a running Chromium CDP on port 9222 and an authenticated session.
 * Inject test session into D1 and set localStorage before running, or log in first.
 *
 * Usage: node test/e2e/pdf-export.mjs
 */

import { chromium } from '~/.local/share/fry-bot/node_modules/playwright-core/index.js';
import { mkdir } from 'node:fs/promises';

const BASE_URL = 'https://inbox-angel-worker.fellowshipdev.workers.dev';
const SCREENSHOT_DIR = '/tmp/ia-test-pdf';

await mkdir(SCREENSHOT_DIR, { recursive: true });

let browser;
try {
  browser = await chromium.connectOverCDP('http://localhost:9222');
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();

  // Step 1: Navigate to overview
  await page.goto(`${BASE_URL}/#/`);
  await page.waitForSelector('text=Export PDF', { timeout: 10_000 });
  console.log('✓ Overview loaded with Export PDF button');
  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-overview-with-export-btn.png` });

  // Step 2: Set up download listener BEFORE clicking
  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
  await page.click('button:has-text("Export PDF")');

  // Step 3: Wait for button to show "Generating…"
  await page.waitForSelector('button:has-text("Generating")', { timeout: 5_000 });
  console.log('✓ PDF generation started (Generating… state visible)');

  // Step 4: Wait for download to trigger
  const download = await downloadPromise;
  const filename = download.suggestedFilename();
  console.log(`✓ PDF download triggered: ${filename}`);

  if (!filename.endsWith('.pdf')) {
    throw new Error(`Expected .pdf filename, got: ${filename}`);
  }

  await page.screenshot({ path: `${SCREENSHOT_DIR}/02-pdf-downloaded.png` });

  // Step 5: Button returns to normal state
  await page.waitForSelector('button:has-text("Export PDF")', { timeout: 10_000 });
  console.log('✓ Export PDF button returned to normal state after download');

  console.log('\n✅ PDF export smoke test PASSED');
} finally {
  await browser?.close();
}
