import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const reports = [
  {
    id: 'report-1',
    url: 'https://datastudio.google.com/embed/reporting/53a75d46-1e56-4252-b957-67d57077bde2/page/aSU2F',
  },
  {
    id: 'report-2',
    // Prefer the current Looker Studio host, then fall back to the legacy domain.
    url: 'https://lookerstudio.google.com/embed/reporting/d48a4893-4559-4a61-945c-5e91c5d1f90f/page/aSU2F',
    fallbackUrls: [
      'https://datastudio.google.com/embed/reporting/d48a4893-4559-4a61-945c-5e91c5d1f90f/page/aSU2F',
    ],
  },
  {
    id: 'report-3',
    // Power BI Publish to web link supplied by the user.
    url: 'https://app.powerbi.com/view?r=eyJrIjoiY2RmNWJiMGMtYjRkYi00MWI3LWI1OTYtMWFjZDdhNzQzZGFkIiwidCI6IjdlYWIxY2VkLWNkZTUtNDZjYS04NDQwLWRkM2M1ZTU3ZjdhZiIsImMiOjR9',
    waitMs: 65000,
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
    const candidates = [report.url, ...(report.fallbackUrls ?? [])];
    let captured = false;
    let lastError = null;

    try {
      for (const url of candidates) {
        try {
          console.log(`Opening ${report.id}: ${url}`);
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
          // Looker Studio and Power BI render charts asynchronously.
          await page.waitForTimeout(report.waitMs ?? 50000);

          // Read all frames as the access notice can be rendered inside an embedded frame.
          const frameTexts = await Promise.all(page.frames().map(frame =>
            frame.locator('body').innerText({ timeout: 2500 }).catch(() => '')
          ));
          const pageText = frameTexts.join(' ').replace(/\s+/g, ' ').toLowerCase();
          const accessError = /can't access report|cant access report|please sign in to your google account|no se puede acceder al informe|owner has disabled embedding|inhabilitado la visualización|this content isn't available|you don't have access|sign in to continue|report is not available|something went wrong/i.test(pageText);
          if (accessError) {
            throw new Error('The report displayed an access/sign-in/error screen.');
          }

          await page.screenshot({
            path: `captures/${report.id}.png`,
            type: 'png',
            fullPage: false,
            animations: 'disabled',
          });
          console.log(`Saved captures/${report.id}.png`);
          captured = true;
          break;
        } catch (error) {
          lastError = error;
          console.warn(`Attempt failed for ${report.id} at ${url}:`, error.message);
        }
      }

      if (!captured) {
        // Keep the last known image rather than overwriting it with a login/error screen.
        console.error(`WARNING: keeping existing captures/${report.id}.png; all URL variants failed.`, lastError);
      }
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
