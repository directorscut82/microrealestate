import * as PdfEngine from './engine/chromeheadless.js';
import { logger, Service, ServiceError } from '@microrealestate/common';
import dataPicker from './datapicker.js';
import ejs from 'ejs';
import fs from 'fs';
import { Semaphore } from 'async-mutex';
import path from 'path';
import templateFunctions from './utils/templatefunctions.js';

// Allowlist of templates this service can render. The previous code
// path-joined a raw URL parameter directly into TEMPLATES_DIRECTORY, so
// a malformed `documentId` (e.g. `../../etc/passwd`) was rejected only
// by the .ejs suffix and the existsSync guard. An explicit allowlist
// closes the door before path arithmetic happens.
const VALID_TEMPLATES = new Set([
  'invoice',
  'rentcall',
  'rentcall_reminder',
  'rentcall_last_reminder'
]);

// Replace the global Mutex with a Semaphore. The Mutex serialized every
// PDF render globally, which made bulk rent-call sends linear with no
// way to scale. The semaphore caps concurrent Chromium pages at a
// configurable bound (default 3) so we trade serialization for a known
// memory ceiling.
const CHROMIUM_CONCURRENCY = Math.max(
  1,
  Number(process.env.CHROMIUM_CONCURRENCY) || 3
);
const semaphore = new Semaphore(CHROMIUM_CONCURRENCY);

const settings: Record<string, any> = {
  'view engine': ejs.renderFile,
  'pdf engine': PdfEngine
};

// Background cleanup so generated PDFs and intermediate temp files are
// not retained forever. Runs every 5 minutes, deletes anything older
// than 1 hour. .unref() so the timer never holds the process open at
// shutdown.
let cleanupTimer: NodeJS.Timeout | null = null;
const CLEANUP_INTERVAL_MS = 300_000; // 5m
const FILE_MAX_AGE_MS = 3_600_000; // 1h

function startCleanupTimer() {
  if (cleanupTimer) {
    return;
  }
  cleanupTimer = setInterval(() => {
    const { TEMPORARY_DIRECTORY, PDF_DIRECTORY } =
      Service.getInstance().envConfig.getValues();
    const now = Date.now();
    for (const dir of [
      TEMPORARY_DIRECTORY as string,
      PDF_DIRECTORY as string
    ]) {
      if (!dir || !fs.existsSync(dir)) {
        continue;
      }
      try {
        for (const f of fs.readdirSync(dir)) {
          const p = path.join(dir, f);
          try {
            const stat = fs.statSync(p);
            if (now - stat.mtimeMs > FILE_MAX_AGE_MS) {
              fs.rmSync(p, { recursive: true, force: true });
            }
          } catch (err) {
            logger.warn(`pdf cleanup: failed to inspect ${p}: ${err}`);
          }
        }
      } catch (err) {
        logger.warn(`pdf cleanup: failed to read dir ${dir}: ${err}`);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
}

export function set(key: string, value: unknown) {
  settings[key] = value;
}

export async function start() {
  const { TEMPORARY_DIRECTORY, PDF_DIRECTORY } =
    Service.getInstance().envConfig.getValues();

  if (!fs.existsSync(PDF_DIRECTORY as string)) {
    fs.mkdirSync(PDF_DIRECTORY as string);
  }
  if (!fs.existsSync(TEMPORARY_DIRECTORY as string)) {
    fs.mkdirSync(TEMPORARY_DIRECTORY as string);
  }
  startCleanupTimer();
  await settings['pdf engine'].start();
}

export async function exit() {
  const { TEMPORARY_DIRECTORY } = Service.getInstance().envConfig.getValues();
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  // recursive+force so a non-empty temp dir doesn't crash shutdown.
  try {
    fs.rmSync(TEMPORARY_DIRECTORY as string, { recursive: true, force: true });
  } catch (err) {
    logger.warn(`failed to remove temp dir ${TEMPORARY_DIRECTORY}`, err);
  }
  // The chromium engine exposes `stop()`, not `exit()`. Calling the missing
  // method threw on shutdown and orphaned the chromium process.
  if (typeof settings['pdf engine'].stop === 'function') {
    await settings['pdf engine'].stop();
  }
}

export async function generate(documentId: string, params: Record<string, string>): Promise<string> {
  const { TEMPLATES_DIRECTORY } = Service.getInstance().envConfig.getValues();

  if (!VALID_TEMPLATES.has(documentId)) {
    throw new ServiceError(`Invalid template: ${documentId}`, 422);
  }

  const templateFile = path.join(TEMPLATES_DIRECTORY as string, `${documentId}.ejs`);
  if (!fs.existsSync(templateFile)) {
    logger.error(
      `cannot generate file for a not existing template ${templateFile}`
    );
    throw new Error(
      `cannot generate file for a not existing template ${templateFile}`
    );
  }

  // Semaphore.runExclusive bounds the number of concurrent Chromium
  // operations without blocking the rest of the queue.
  return await semaphore.runExclusive(async () => {
    const data = await dataPicker(documentId, params);
    const html = await settings['view engine'](
      templateFile,
      {
        ...data,
        _: templateFunctions({
          locale: data.landlord.locale,
          currency: data.landlord.currency
        })
      },
      { root: TEMPLATES_DIRECTORY }
    );

    return await settings['pdf engine'].generate(
      documentId,
      html,
      data.fileName
    );
  });
}
