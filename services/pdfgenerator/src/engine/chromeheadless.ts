import { logger, Service } from '@microrealestate/common';
import fileUrl from 'file-url';
import fs from 'fs';
import path from 'path';
import puppeteer, { Browser } from 'puppeteer';

const BROWSER: {
  INSTANCE: Browser | null;
  ARGS: string[];
} = {
  INSTANCE: null,
  ARGS: [
    '--allow-pre-commit-input',
    '--autoplay-policy=user-gesture-required',
    '--block-new-web-contents',
    '--disable-features=IsolateOrigins',
    '--disable-accelerated-2d-canvas',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-breakpad',
    '--disable-client-side-phishing-detection',
    '--disable-component-extensions-with-background-pages',
    '--disable-component-update',
    '--disable-crash-reporter',
    '--disable-crashpad-forwarding',
    '--disable-default-apps',
    '--disable-dev-shm-usage',
    '--disable-domain-reliability',
    '--disable-extensions',
    '--disable-features=AudioServiceOutOfProcess',
    '--disable-features=AutofillServerCommunication',
    '--disable-features=InterestFeedContentSuggestions',
    '--disable-features=Translate',
    '--disable-features=CalculateNativeWinOcclusion',
    '--disable-features=CertificateTransparencyComponentUpdater',
    '--disable-features=DestroyProfileOnBrowserClose',
    '--disable-features=MediaRouter',
    '--disable-features=PaintHolding',
    '--disable-features=site-per-process',
    '--disable-gpu',
    '--disable-hang-monitor',
    '--disable-ipc-flooding-protection',
    '--disable-notifications',
    '--disable-offer-store-unmasked-wallet-cards',
    '--disable-partial-raster',
    '--disable-popup-blocking',
    '--disable-print-preview',
    '--disable-prompt-on-repost',
    '--disable-renderer-backgrounding',
    '--disable-session-crashed-bubble',
    '--disable-setuid-sandbox',
    '--disable-site-isolation-trials',
    '--disable-skia-runtime-opts',
    '--disable-software-rasterizer',
    '--disable-speech-api',
    '--disable-sync',
    '--enable-automation',
    '--enable-low-end-device-mode',
    '--hide-scrollbars',
    '--ignore-gpu-blacklist',
    '--metrics-recording-only',
    '--mute-audio',
    '--no-default-browser-check',
    '--no-first-run',
    '--no-pings',
    '--no-sandbox',
    '--no-service-autorun',
    '--no-zygote',
    '--noerrdialogs',
    '--password-store=basic',
    //'--single-process',  --> crash browser if activated
    '--use-gl=swiftshader',
    '--use-mock-keychain'
  ]
};

// In-flight launch promise — a mutex so concurrent relaunches share ONE launch
// (Step-7 F1). Under CHROMIUM_CONCURRENCY, after a crash nulls the instance,
// N queued generate() calls could each call start() and each spawn a Chromium;
// only the last would be kept in BROWSER.INSTANCE and the other N−1 would be
// orphaned (never killed by stop()), compounding the OOM that caused the crash.
// Memoizing collapses them to a single launch.
let _startInFlight: Promise<void> | null = null;

async function _launch(): Promise<void> {
  const { CHROMIUM_BIN } = Service.getInstance().envConfig.getValues();
  try {
    // If a concurrent caller already relaunched a live browser while we were
    // queued, don't spawn another (and orphan it).
    if (BROWSER.INSTANCE && BROWSER.INSTANCE.connected) return;
    const instance = await puppeteer.launch({
      executablePath: (CHROMIUM_BIN as string) || undefined,
      headless: true,
      args: BROWSER.ARGS
    });
    BROWSER.INSTANCE = instance;
    instance.on('error', (error) => logger.error('chromium error:', error));
    instance.on('disconnected', () => {
      // If the browser dies (crash/OOM), the handle is dead but non-null, so
      // every subsequent generate() would call newPage() on it and hang. Null
      // it so generate() relaunches on the next request (ingress+error-path
      // audit 2026-07). Only null if THIS instance is the current one AND it is
      // actually dead — never null a NEW instance from a stale disconnect event
      // fired after an intentional stop()/restart.
      if (BROWSER.INSTANCE === instance && !instance.connected) {
        BROWSER.INSTANCE = null;
      }
      logger.warn('chromium has been disconnected');
    });
  } catch (error) {
    logger.error('something went wrong when starting chromium', error);
  }
}

export async function start() {
  // Coalesce concurrent starts onto one in-flight launch.
  if (_startInFlight) return _startInFlight;
  _startInFlight = _launch().finally(() => {
    _startInFlight = null;
  });
  return _startInFlight;
}

export async function stop() {
  try {
    if (BROWSER.INSTANCE) {
      await BROWSER.INSTANCE.close();
      BROWSER.INSTANCE.process()?.kill(9);
    }
  } catch (error) {
    logger.error(error);
  }
}

export async function generate(documentId: string, html: string, fileName: string): Promise<string> {
  // Relaunch if the browser died (disconnect handler nulled it) or was never
  // started. Without this, one Chromium crash would make every subsequent PDF
  // request fail permanently until the service restarts (ingress+error-path
  // audit 2026-07).
  if (!BROWSER.INSTANCE || !BROWSER.INSTANCE.connected) {
    logger.warn('chromium not available, (re)starting before generate');
    await start();
  }
  if (!BROWSER.INSTANCE) {
    throw new Error('chromium has not been started');
  }

  const page = await BROWSER.INSTANCE.newPage();
  try {
    page.on('error', (error) => {
      logger.error('chromium page error', error);
    });

    const { TEMPORARY_DIRECTORY, PDF_DIRECTORY } =
      Service.getInstance().envConfig.getValues();
    const html_file = path.join(TEMPORARY_DIRECTORY as string, `${fileName}.html`);
    const pdf_file = path.join(PDF_DIRECTORY as string, `${fileName}.pdf`);

    logger.debug(`writing ${html_file} on disk`);
    fs.writeFileSync(html_file, html, 'utf8');
    logger.debug('write html done');

    const pageUrl = fileUrl(html_file);
    logger.debug(`chromium navigating to ${pageUrl}`);
    // Bound navigation + render so a wedged page can't pin the concurrency
    // semaphore forever (ingress+error-path audit 2026-07). The page.close()
    // in finally still runs, freeing the slot.
    await page.goto(pageUrl, { timeout: 60_000 });

    logger.debug(`chromium started generating pdf for ${pageUrl}`);
    const buffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      timeout: 60_000
    });
    fs.writeFileSync(pdf_file, buffer);
    logger.debug(`done ${pdf_file}`);

    return pdf_file;
  } finally {
    // Never let page.close() mask the real error. When the browser crashed
    // mid-render (the OOM path these fixes target), the goto/pdf above rejects
    // with the ACTIONABLE error, then close() on the dead connection throws
    // "Protocol error: Connection closed" — which would REPLACE the propagating
    // error and blind the logs to the crash cause (Step-7 F2). Swallow the
    // close error; the propagating render error survives, and the semaphore
    // still frees.
    try {
      await page.close();
    } catch (closeErr: any) {
      logger.warn(
        `chromium page.close() failed (ignored): ${closeErr?.message || closeErr}`
      );
    }
  }
}
