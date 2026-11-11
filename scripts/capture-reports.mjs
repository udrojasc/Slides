import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const VIEWPORT = { width: 1920, height: 1080 };
const SAMPLE_INTERVAL_MS = 5000;
const REQUIRED_STABLE_SAMPLES = 2;
const MAX_CHANGED_PIXEL_RATIO = 0.001;

const reports = [
  {
    id: 'report-1',
    url: 'https://datastudio.google.com/embed/reporting/53a75d46-1e56-4252-b957-67d57077bde2/page/aSU2F',
    minWaitMs: 90000,
    maxWaitMs: 180000,
  },
  {
    id: 'report-2',
    url: 'https://lookerstudio.google.com/embed/reporting/d48a4893-4559-4a61-945c-5e91c5d1f90f/page/aSU2F',
    fallbackUrls: [
      'https://datastudio.google.com/embed/reporting/d48a4893-4559-4a61-945c-5e91c5d1f90f/page/aSU2F',
    ],
    minWaitMs: 90000,
    maxWaitMs: 180000,
  },
  {
    id: 'report-4',
    // Public Looker Studio report requested for Slides.
    url: 'https://lookerstudio.google.com/embed/reporting/243472f7-689e-4d6a-b517-a6e73cc3603b/page/aSU2F',
    fallbackUrls: [
      'https://datastudio.google.com/embed/reporting/243472f7-689e-4d6a-b517-a6e73cc3603b/page/aSU2F',
    ],
    // This report has taken longer to finish rendering than the existing dashboards.
    minWaitMs: 120000,
    maxWaitMs: 240000,
  },
  {
    id: 'report-3',
    // Power BI Publish to web link supplied by the user.
    url: 'https://app.powerbi.com/view?r=eyJrIjoiY2RmNWJiMGMtYjRkYi00MWI3LWI1OTYtMWFjZDdhNzQzZGFkIiwidCI6IjdlYWIxY2VkLWNkZTUtNDZjYS04NDQwLWRkM2M1ZTU3ZjdhZiIsImMiOjR9',
    minWaitMs: 90000,
    maxWaitMs: 180000,
  },
];

const ACCESS_ERROR_PATTERN = /can't access report|cant access report|please sign in to your google account|no se puede acceder al informe|owner has disabled embedding|inhabilitado la visualización|this content isn't available|you don't have access|sign in to continue|report is not available|something went wrong/i;
const LOADING_TEXT_PATTERN = /loading (?:your )?report|loading data|preparing (?:the )?report|rendering (?:the )?report|cargando (?:el )?(?:informe|datos)/i;

function getPngDimensions(buffer) {
  const decoded = PNG.sync.read(buffer);
  return { width: decoded.width, height: decoded.height, decoded };
}

function changedPixelRatio(previousBuffer, currentBuffer) {
  const previous = getPngDimensions(previousBuffer);
  const current = getPngDimensions(currentBuffer);

  if (previous.width !== current.width || previous.height !== current.height) {
    return 1;
  }

  let changedPixels = 0;
  const totalPixels = current.width * current.height;
  const a = previous.decoded.data;
  const b = current.decoded.data;

  // Ignore tiny antialiasing changes; detect meaningful report/chart movement.
  for (let offset = 0; offset < a.length; offset += 4) {
    const difference = Math.max(
      Math.abs(a[offset] - b[offset]),
      Math.abs(a[offset + 1] - b[offset + 1]),
      Math.abs(a[offset + 2] - b[offset + 2])
    );
    if (difference > 20) changedPixels++;
  }

  return changedPixels / totalPixels;
}

async function inspectFrames(page) {
  return Promise.all(page.frames().map(async frame => {
    try {
      return await frame.evaluate(() => {
        const body = document.body;
        const root = document.documentElement;
        const text = (body?.innerText || '').replace(/\s+/g, ' ').trim();
        const visible = element => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 &&
            style.display !== 'none' && style.visibility !== 'hidden';
        };

        return {
          url: location.href,
          readyState: document.readyState,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          documentWidth: Math.max(root?.scrollWidth || 0, body?.scrollWidth || 0),
          documentHeight: Math.max(root?.scrollHeight || 0, body?.scrollHeight || 0),
          textLength: text.length,
          textPreview: text.slice(0, 350),
          textForChecks: text.slice(0, 10000),
          canvasCount: [...document.querySelectorAll('canvas')].filter(visible).length,
          svgCount: [...document.querySelectorAll('svg')].filter(visible).length,
          loadedImageCount: [...document.images].filter(image =>
            visible(image) && image.complete && image.naturalWidth > 0
          ).length,
          brokenImageCount: [...document.images].filter(image =>
            visible(image) && image.complete && image.naturalWidth === 0
          ).length,
          progressCount: document.querySelectorAll('[role="progressbar"]').length,
          busyCount: document.querySelectorAll('[aria-busy="true"]').length,
        };
      });
    } catch (error) {
      return { url: frame.url(), inspectionError: error.message };
    }
  }));
}

function summarizeFrames(frames) {
  return frames.map(frame => ({
    url: frame.url,
    readyState: frame.readyState,
    viewport: frame.viewportWidth && frame.viewportHeight
      ? frame.viewportWidth + 'x' + frame.viewportHeight
      : undefined,
    document: frame.documentWidth && frame.documentHeight
      ? frame.documentWidth + 'x' + frame.documentHeight
      : undefined,
    textLength: frame.textLength,
    canvas: frame.canvasCount,
    svg: frame.svgCount,
    images: frame.loadedImageCount,
    progress: frame.progressCount,
    busy: frame.busyCount,
    preview: frame.textPreview,
    error: frame.inspectionError,
  }));
}

async function waitForFonts(page) {
  await Promise.all(page.frames().map(frame =>
    frame.evaluate(async () => {
      if (document.fonts?.ready) await document.fonts.ready;
    }).catch(() => {})
  ));
}

async function waitForStableReport(page, report) {
  await waitForFonts(page);
  await page.waitForTimeout(report.minWaitMs);

  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, report.maxWaitMs - report.minWaitMs);
  let previousScreenshot = null;
  let stableSamples = 0;
  let lastDiagnostics = [];

  while (Date.now() <= deadline) {
    const diagnostics = await inspectFrames(page);
    lastDiagnostics = diagnostics;
    const combinedText = diagnostics.map(frame => frame.textForChecks || frame.textPreview || '').join(' ');
    const contentElements = diagnostics.reduce((total, frame) =>
      total + (frame.canvasCount || 0) + (frame.svgCount || 0) + (frame.loadedImageCount || 0), 0
    );
    const hasReadableContent = diagnostics.some(frame => (frame.textLength || 0) >= 40);
    const hasVisibleContent = contentElements > 0 || hasReadableContent;

    if (ACCESS_ERROR_PATTERN.test(combinedText)) {
      throw new Error('Looker/Power BI devolvió un aviso de acceso, inicio de sesión o error.');
    }

    const screenshot = await page.screenshot({
      type: 'png',
      fullPage: false,
      animations: 'disabled',
    });

    const dimensions = getPngDimensions(screenshot);
    if (dimensions.width !== VIEWPORT.width || dimensions.height !== VIEWPORT.height) {
      throw new Error(
        'Dimensiones inesperadas: ' + dimensions.width + 'x' + dimensions.height +
        '; se esperaba 1920x1080.'
      );
    }

    const loadingVisible = LOADING_TEXT_PATTERN.test(combinedText);
    let difference = 1;

    if (previousScreenshot) {
      difference = changedPixelRatio(previousScreenshot, screenshot);
      if (difference <= MAX_CHANGED_PIXEL_RATIO && !loadingVisible && hasVisibleContent) {
        stableSamples++;
      } else {
        stableSamples = 0;
      }
    }

    console.log(
      report.id + ': estabilidad visual ' + Math.round(difference * 10000) / 100 + '%; ' +
      'muestras estables ' + stableSamples + '/' + REQUIRED_STABLE_SAMPLES + '; ' +
      'contenido visible=' + hasVisibleContent + '; indicador de carga=' + loadingVisible
    );

    if (stableSamples >= REQUIRED_STABLE_SAMPLES) {
      return { screenshot, diagnostics };
    }

    previousScreenshot = screenshot;
    await page.waitForTimeout(SAMPLE_INTERVAL_MS);
  }

  console.error('Diagnóstico final de ' + report.id + ':', summarizeFrames(lastDiagnostics));
  throw new Error(
    'El informe no alcanzó un estado visual estable dentro de ' +
    Math.round(report.maxWaitMs / 1000) + ' segundos. Se conserva la última captura válida.'
  );
}

await mkdir('captures', { recursive: true });
const browser = await chromium.launch({ headless: true });
const failedReports = [];

try {
  for (const report of reports) {
    const page = await browser.newPage({
      viewport: VIEWPORT,
      screen: VIEWPORT,
      deviceScaleFactor: 1,
      colorScheme: 'light',
      reducedMotion: 'reduce',
    });

    page.setDefaultTimeout(15000);
    const candidates = [report.url, ...(report.fallbackUrls ?? [])];
    let captured = false;
    let lastError = null;

    try {
      for (const url of candidates) {
        try {
          console.log('Opening ' + report.id + ': ' + url);
          await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 90000,
          });

          // networkidle is only a best-effort hint; report charts can load afterwards.
          await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {
            console.log(report.id + ': la red sigue activa; se espera a la estabilización visual.');
          });

          const result = await waitForStableReport(page, report);
          const dimensions = getPngDimensions(result.screenshot);
          await writeFile('captures/' + report.id + '.png', result.screenshot);

          console.log(
            'Saved captures/' + report.id + '.png (' +
            dimensions.width + 'x' + dimensions.height + ', 16:9).'
          );
          console.log('Frames de ' + report.id + ':', summarizeFrames(result.diagnostics));
          captured = true;
          break;
        } catch (error) {
          lastError = error;
          console.warn('Attempt failed for ' + report.id + ' at ' + url + ':', error.message);
        }
      }

      if (!captured) {
        // Do not overwrite a good image with an incomplete dashboard or an error page.
        failedReports.push(report.id);
        console.error(
          'ERROR: no se actualizó captures/' + report.id + '.png; se conserva la última versión válida.',
          lastError
        );
      }
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}

if (failedReports.length > 0) {
  console.error('Capturas fallidas: ' + failedReports.join(', '));
  process.exitCode = 1;
} else {
  console.log('Todas las capturas se validaron y guardaron en 1920x1080.');
}
