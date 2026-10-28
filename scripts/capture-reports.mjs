import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const reports = [
  {
    id: 'report-1',
    url: 'https://datastudio.google.com/embed/reporting/53a75d46-1e56-4252-b957-67d57077bde2/page/aSU2F',
  },
  {
    id: 'report-2',
    url: 'https://datastudio.google.com/embed/reporting/d48a4893-4559-4a61-945c-5e91c5d1f90f/page/aSU2F',
  },
];

await mkdir('captures', { recursive: true });
const browser = await chromium.launch({ headless: true });
let failed = false;

try {
  for (const report of reports) {
    const page = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
    });

    try {
      console.log(`Opening ${report.id}`);
      await page.goto(report.url, { waitUntil: 'domcontentloaded', timeout: 90000 });
      // Looker Studio renders charts asynchronously after the document loads.
      await page.waitForTimeout(50000);

      const bodyText = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
      if (/no se puede acceder al informe|owner has disabled embedding|inhabilitado la visualización/i.test(bodyText)) {
        throw new Error('Looker Studio showed an access or embedding error.');
      }

      await page.screenshot({
        path: `captures/${report.id}.png`,
        type: 'png',
        fullPage: false,
        animations: 'disabled',
      });
      console.log(`Saved captures/${report.id}.png`);
    } catch (error) {
      failed = true;
      console.error(`Capture failed for ${report.id}:`, error);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}

if (failed) {
  process.exitCode = 1;
}
