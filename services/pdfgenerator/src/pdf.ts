import * as PdfEngine from './engine/chromeheadless.js';
import { Collections, logger, Service, ServiceError } from '@microrealestate/common';
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
// not retained forever. Runs every 5 minutes. .unref() so the timer never
// holds the process open at shutdown.
//
// TEMPORARY_DIRECTORY / PDF_DIRECTORY hold short-lived render artifacts and
// expire after 1h. UPLOADS_DIRECTORY holds user-uploaded source files that
// might be referenced by Document records, so we use a longer 24h floor and
// additionally skip any file that is referenced by an existing Document.
// This catches orphans from failed POST /documents calls without ever
// removing a live attachment.
let cleanupTimer: NodeJS.Timeout | null = null;
const CLEANUP_INTERVAL_MS = 300_000; // 5m
const TEMP_FILE_MAX_AGE_MS = 3_600_000; // 1h — temp + pdf
const UPLOAD_FILE_MAX_AGE_MS = 86_400_000; // 24h — uploads (longer than render artifacts)

async function _collectReferencedUploadUrls(
  uploadsRoot: string
): Promise<Set<string>> {
  // Pull every file-typed Document and translate its stored relative URL
  // to an absolute path under uploadsRoot, matching the layout used by the
  // upload route. We compare absolute paths so a moved uploads root or a
  // weird `..` in a stored URL still maps back consistently.
  const referenced = new Set<string>();
  try {
    const docs: any[] = await Collections.Document.find(
      { type: 'file' },
      { url: 1 }
    ).lean();
    for (const doc of docs) {
      if (!doc?.url || typeof doc.url !== 'string') continue;
      // Strip leading slash(es) — path.resolve treats absolute-looking inputs
      // as roots and would compute a path OUTSIDE uploadsRoot, so the live
      // attachment would not get added to the referenced set and the cleanup
      // sweep would happily delete it.
      const cleanUrl = String(doc.url || '').replace(/^\/+/, '');
      const resolved = path.resolve(uploadsRoot, cleanUrl);
      referenced.add(resolved);
    }
  } catch (err) {
    logger.warn(`pdf cleanup: failed to load Document refs: ${err}`);
  }
  return referenced;
}

function _walkDirSync(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(_walkDirSync(p) as string[]));
    } else if (e.isFile()) {
      out.push(p);
    }
  }
  return out;
}

// Re-entrancy guard for the cleanup interval. The sweep walks the uploads
// tree and queries Document records — under load (large uploads dir, slow
// mongo) a single tick can take longer than CLEANUP_INTERVAL_MS, and
// setInterval will fire the next iteration on top of the still-running
// one. Two concurrent sweeps then race fs.statSync / fs.rmSync on the
// same paths and emit ENOENT noise in logs. Skip the tick when one is
// already in flight.
let cleanupRunning = false;

function startCleanupTimer() {
  if (cleanupTimer) {
    return;
  }
  cleanupTimer = setInterval(async () => {
    if (cleanupRunning) {
      return;
    }
    cleanupRunning = true;
    try {
    const { TEMPORARY_DIRECTORY, PDF_DIRECTORY, UPLOADS_DIRECTORY } =
      Service.getInstance().envConfig.getValues();
    const now = Date.now();

    // Render artifacts — flat directory, 1h floor.
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
            if (now - stat.mtimeMs > TEMP_FILE_MAX_AGE_MS) {
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

    // Uploads — nested by org, 24h floor, skip if referenced by a Document.
    const uploadsRoot = UPLOADS_DIRECTORY as string;
    if (uploadsRoot && fs.existsSync(uploadsRoot)) {
      try {
        const resolvedRoot = path.resolve(uploadsRoot);
        const referenced = await _collectReferencedUploadUrls(resolvedRoot);
        const files = _walkDirSync(resolvedRoot);
        for (const p of files) {
          try {
            if (referenced.has(path.resolve(p))) continue;
            const stat = fs.statSync(p);
            if (now - stat.mtimeMs > UPLOAD_FILE_MAX_AGE_MS) {
              fs.rmSync(p, { force: true });
            }
          } catch (err) {
            logger.warn(`pdf cleanup: failed to inspect upload ${p}: ${err}`);
          }
        }
      } catch (err) {
        logger.warn(`pdf cleanup: failed to scan uploads ${uploadsRoot}: ${err}`);
      }
    }
    } finally {
      cleanupRunning = false;
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
