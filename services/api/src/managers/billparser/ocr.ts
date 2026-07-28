/**
 * OCR module — lazy-singleton PaddleOCR inference via onnxruntime-web WASM.
 *
 * Runs the PP-OCRv6 detection + el_PP-OCRv5 Greek recognition models
 * entirely in-process (no sidecar, no Python, no native addon).
 *
 * MEASURED on the real NAS (x86_64, 4-core, Alpine container):
 *   - Session init: ~2s (one-time)
 *   - Per-bill OCR: ~21s (4 threads) / ~56s (1 thread)
 *   - Peak RSS: ~273MB (session resident ~239MB + per-bill ~34MB)
 *
 * The session is created ONCE on first use and reused — per-request
 * createInstance re-pays the ~175MB/2s cost and must be avoided.
 */
import { logger } from '@microrealestate/common';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.resolve(__dirname, '../../../models');

// Lazy-loaded singleton — neither the models nor onnxruntime-web are loaded
// until the first bill image arrives. This keeps api's boot memory at ~100MB
// and avoids the 175MB session cost when no OCR is needed.
let _svcPromise: Promise<any> | null = null;

async function _createService() {
  // Dynamic imports so the ~8MB WASM binary + models don't enter the boot path.
  const { PaddleOcrService, Image } = await import('paddleocr');
  const ort = await import('onnxruntime-web');

  // WASM threading: WORKS in Node 20 on Alpine (verified on NAS, contradicts
  // Microsoft's compat matrix). 4 threads → 2.6× speedup. Cap at 3 to leave
  // headroom for concurrent api request handling under production contention.
  ort.env.wasm.numThreads = 3;

  const detBuf = readFileSync(path.join(MODELS_DIR, 'PP-OCRv6_det_small.onnx'));
  const recBuf = readFileSync(
    path.join(MODELS_DIR, 'el_PP-OCRv5_rec_mobile.onnx')
  );
  const rawDict = readFileSync(path.join(MODELS_DIR, 'greek_dict.txt'), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0);
  // CTC convention: [blank, ...354_dict_chars, space] = 356 classes
  const dict = ['blank', ...rawDict, ' '];

  const toAB = (b: Buffer) =>
    b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

  const svc = await PaddleOcrService.createInstance({
    ort: ort as any,
    detection: {
      modelBuffer: toAB(detBuf),
      // ImageNet normalization on BGR — verified from PP-OCRv5_mobile_det.yml
      // and predict_det.py (NormalizeImage: scale 1/255, mean [0.485,0.456,0.406],
      // std [0.229,0.224,0.225], applied to BGR channel order).
      channelOrder: 'bgr',
      mean: [123.675, 116.28, 103.53] as [number, number, number],
      stdDeviation: [
        1 / (0.229 * 255),
        1 / (0.224 * 255),
        1 / (0.225 * 255)
      ] as [number, number, number],
      // Official inference defaults (utility.py) — tuned boxScore/unclip for
      // CamScanner scans (verified: 112 lines, 7/7 critical fields on real bill).
      limitType: 'max',
      maxSideLength: 960,
      boxScoreThreshold: 0.55,
      unclipRatio: 1.6
    },
    recognition: {
      modelBuffer: toAB(recBuf),
      charactersDictionary: dict
      // mean/std are [127.5]/[1/127.5] (uniform) → channel order IRRELEVANT.
      // Defaults are correct; no override needed.
    }
    // CLS angle classifier: deliberately DISABLED — the ch_ppocr_mobile_v2.0_cls
    // model is Chinese-trained and garbles Greek text (tested: ΕΠΑΖΑΝΕ/ΖΕΝΖΟΣΝ).
  });

  logger.info('OCR session created (paddleocr + onnxruntime-web WASM)');
  return { svc, Image };
}

function getService() {
  // Cooldown-gated self-heal: if OCR has been stuck (a recognize timed out and
  // never settled) for longer than the cooldown, rebuild the gate + session.
  //
  // WHY THIS CANNOT CORRUPT (Step-7 round-5, verified against the shipped
  // onnxruntime-web node bundle): the WASM module, heap, and pthread pool are
  // PROCESS-GLOBAL and shared by every session — session "objects" are just
  // integer handles into the one runtime, so isolation-by-new-session is NOT
  // what makes this safe. What makes it safe is that `_OrtRun` is a SYNCHRONOUS
  // WASM export on the single JS thread (the `await` around session.run is
  // cosmetic; the main thread blocks until compute returns). Two recognize
  // calls therefore can never overlap in wall-clock time, rebuilt session or
  // not — concurrent-run corruption is structurally impossible in this runtime.
  //
  // COVERAGE (honest scope): the same synchronous-run fact means a TRUE WASM
  // deadlock freezes the whole event loop — no timer fires, no request runs,
  // and no in-process watchdog (this one included) can execute; the container
  // goes unresponsive and the orchestrator restart is the real recovery for
  // that class. What this self-heal DOES recover — without a restart — is the
  // stuck-flag wedge: a recognize whose JS promise never settles while the
  // event loop is alive (settled-late-after-timeout bookkeeping, a rejected
  // internal chain, or any future async seam in the recognize path). In that
  // state _recognizeStuck would otherwise gate ALL future OCR forever.
  _maybeSelfHealOcr();
  if (!_svcPromise) {
    _svcPromise = _createService().catch((err) => {
      // Reset so a transient failure (e.g., OOM during init) doesn't lock
      // all future OCR calls into a rejected promise permanently.
      _svcPromise = null;
      throw err;
    });
  }
  return _svcPromise;
}

function _maybeSelfHealOcr() {
  if (
    _recognizeStuck &&
    _stuckSince !== null &&
    Date.now() - _stuckSince >= OCR_STUCK_COOLDOWN_MS
  ) {
    logger.warn(
      `OCR stuck for >${Math.round(OCR_STUCK_COOLDOWN_MS / 1000)}s — rebuilding gate + session (self-heal). A prior recognize never settled.`
    );
    // Bump the generation so the wedged call's late-settling gate handlers
    // (if it ever resolves) no-op instead of corrupting the fresh counters.
    _gateGeneration++;
    _recognizeGate = Promise.resolve();
    _recognizeWaiters = 0;
    _recognizeStuck = false;
    _stuckSince = null;
    // Release the old session's WASM-heap allocations (model weights) before
    // dropping the reference — the heap is process-global, so without an
    // explicit destroy() each self-heal would LEAK the prior session's weights
    // (Step-7 round-5; paddleocr exposes destroy() → _OrtReleaseSession).
    // Best-effort: the session may be in an odd state, and the JS thread being
    // alive here means no _OrtRun is executing (synchronous), so the release
    // cannot race a live inference.
    if (_svcPromise) {
      _svcPromise
        .then((s: any) => s?.svc?.destroy?.())
        .catch(() => undefined);
    }
    // Force a fresh ONNX session on the next getService() body below. The new
    // session shares the process-global WASM runtime with the old one — that is
    // fine per the synchronous-run argument above.
    _svcPromise = null;
  }
}

/**
 * Rasterize every page of a (scanned/image-only) PDF to PNG buffers, in-process,
 * via @hyzyla/pdfium — PURE WASM, no native addon, no libc dep (same class as
 * onnxruntime-web; runs on the existing Alpine/musl image). pdfium renders a
 * BGRA bitmap; sharp (musl prebuild) wraps it into a PNG for ocrImage.
 * scale 2 ≈ 144dpi — enough for the recognizer without exploding memory.
 */
// Bills are ~1-4 pages. Cap rasterization so a pathological many-page PDF can't
// pin a worker for minutes / spike memory (each page ≈ full-res RGBA + PNG, all
// held until OCR). Excess pages are dropped with a WARNING (not silent) — a real
// utility bill never exceeds this, and OCR beyond it wouldn't find bill fields.
const MAX_PDF_PAGES = 10;

export async function rasterizePdfToImages(buffer: Buffer): Promise<Buffer[]> {
  const { PDFiumLibrary } = await import('@hyzyla/pdfium');
  const { default: sharp } = await import('sharp');
  const lib = await PDFiumLibrary.init();
  try {
    const doc = await lib.loadDocument(buffer);
    try {
      const pages: Buffer[] = [];
      const total = doc.getPageCount();
      const n = Math.min(total, MAX_PDF_PAGES);
      if (total > MAX_PDF_PAGES) {
        logger.warn(
          `Bill PDF has ${total} pages; OCR'ing only the first ${MAX_PDF_PAGES}`
        );
      }
      // NOTE: @hyzyla/pdfium PDFiumPage exposes no destroy() (verified in its
      // .d.ts — only Library/Document are disposable); page handles are released
      // with doc.destroy() below. No per-page leak.
      for (let i = 0; i < n; i++) {
        const page = doc.getPage(i);
        // Bound the rendered bitmap. A fixed scale:2 is fine for an A4 page
        // (595×842pt → 1190×1684px ≈ 2MP) but a large-format or malicious
        // MediaBox (e.g. A0, or a crafted huge page) renders a giant RGBA
        // bitmap that OOM-kills the 384MB container BEFORE ocrImage's cap runs.
        // Derive the scale from the page's point size so the longest rendered
        // side is ≤ MAX_OCR_SIDE, and never upscale past the 2× (~144dpi)
        // default. Output px ≤ 2600² ≈ 6.8MP, well under the decode cap.
        const { originalWidth, originalHeight } = page.getOriginalSize();
        const longestPt = Math.max(originalWidth || 0, originalHeight || 0);
        const scale =
          longestPt > 0 ? Math.min(2, MAX_OCR_SIDE / longestPt) : 2;
        const bitmap: any = await page.render({ scale, render: 'bitmap' });
        const png = await sharp(Buffer.from(bitmap.data), {
          raw: { width: bitmap.width, height: bitmap.height, channels: 4 }
        })
          .png()
          .toBuffer();
        pages.push(png);
      }
      return pages;
    } finally {
      doc.destroy();
    }
  } finally {
    lib.destroy();
  }
}

// Memory bounds for the decode. The api container is capped at 384MB and the
// warm OCR session is ~239MB resident, leaving ~145MB of headroom. A full-res
// decode to raw RGBA is 4 bytes/px, so an uncapped image OOM-kills the whole
// container: a 12MP phone photo = 46MB, a 48MP = 183MB, and a small
// "pixel-bomb" PNG can claim hundreds of MP. So:
//   1. reject anything above MAX_OCR_MEGAPIXELS via a header-only metadata read
//      (no full decode happens for an oversized/malicious file → clean 422,
//      never an OOM);
//   2. downscale so the longest side is <= MAX_OCR_SIDE before handing raw
//      pixels to the recognizer — bounds the RGBA buffer to ~2600²·4 ≈ 27MB
//      regardless of input, and is still far more detail than the recognizer
//      needs (detection internally caps at maxSideLength 960).
const MAX_OCR_MEGAPIXELS = 30;
const MAX_OCR_INPUT_PIXELS = MAX_OCR_MEGAPIXELS * 1_000_000;
const MAX_OCR_SIDE = 2600;

// The 30MP header cap only bounds PEAK memory for formats sharp can shrink
// on load (JPEG: libjpeg decodes at reduced resolution when .resize() shrinks
// by ≥2×, so the full-res raw buffer is never materialized). PNG/WEBP/TIFF/GIF
// have NO shrink-on-load in sharp — they decode the ENTIRE image to raw RGBA
// (4 B/px) BEFORE resize. A 30MP PNG = 120MB raw, which on top of the ~239MB
// warm OCR session blows the 384MB container cap. So non-shrink formats get a
// tighter cap: 12MP · 4 B = 48MB raw, leaving comfortable headroom. A 300dpi
// A4 scan is ~8.7MP, so real bills are unaffected.
const MAX_OCR_DECODE_MEGAPIXELS = 12;
const MAX_OCR_DECODE_INPUT_PIXELS = MAX_OCR_DECODE_MEGAPIXELS * 1_000_000;
const SHRINK_ON_LOAD_FORMATS = new Set(['jpeg', 'jpg']);

// Pick the effective pixel budget for THIS image: the generous 30MP cap when
// sharp can shrink it on load, else the tighter full-decode cap.
function effectiveMaxPixels(format?: string): number {
  return format && SHRINK_ON_LOAD_FORMATS.has(format)
    ? MAX_OCR_INPUT_PIXELS
    : MAX_OCR_DECODE_INPUT_PIXELS;
}

// Serialize OCR decode+inference. Concurrent uploads must NOT each hold a
// full RGBA buffer + run inference simultaneously — that multiplies peak RSS
// past the container cap. One image at a time keeps peak RSS at
// session + single-image; the batch just takes longer, which is fine.
let _ocrChain: Promise<unknown> = Promise.resolve();

// Hard ceiling on a single recognize() call. Measured OCR is ~21s (3-4
// threads) / ~56s (1 thread), so 120s never false-trips a real bill (each PDF
// page is a SEPARATE recognize, so this is per-page, not per-multi-page-PDF)
// but stops a pathologically slow inference from hanging the request/poller
// tick forever (ingress+error-path audit 2026-07).
const OCR_RECOGNIZE_TIMEOUT_MS = 120_000;

// Dedicated serialization gate for the ACTUAL recognize call. The onnxruntime
// InferenceSession is NOT reentrant — two concurrent svc.recognize() calls on
// the one warm singleton corrupt each other's output, which here becomes wrong
// bill figures (Step-7 money-adjacent finding). _ocrChain serializes whole
// _ocrImageInner calls, but it ADVANCES when a call rejects at the timeout —
// while the abandoned inference is still running — so it alone does not prevent
// a concurrent session call. This gate advances ONLY when the real inference
// truly settles, never on the caller's timeout, so the next recognize always
// waits for the session to be free.
let _recognizeGate: Promise<unknown> = Promise.resolve();

// Bound the queue behind the gate (Step-7 round-2 MED). Each queued caller
// retains its ~27MB RGBA buffer inside the pending `.then(() => recognize(img))`
// closure until the gate settles. Behind a HUNG inference (or merely a pile-up
// slower than the arrival rate), an unbounded queue would retain one buffer per
// caller and OOM the WHOLE api container (session ~239MB + N×27MB vs the 384MB
// cap). So:
//   - _recognizeWaiters caps how many may queue+run; excess callers fast-reject
//     (clean error, buffer released immediately) instead of piling up.
//   - _recognizeStuck: once a call exceeds its timeout without settling
//     (presumed hung), new calls fast-reject rather than queue behind the
//     zombie; it clears when that call finally settles (recovers without a
//     restart if it was merely very slow, not infinitely hung).
// Cap 2 keeps retained buffers within the 384MB container cap by the file's own
// numbers (session ~239MB + per-bill ~34MB → 2×34+239 = 307MB, ~77MB headroom
// for the rest of the api).
// A merely-slow (not infinite) call self-heals when it settles; a TRULY hung
// WASM call is recovered by the cooldown-gated rebuild in _maybeSelfHealOcr
// (no container restart needed — Step-7 round-3 residual closed).
// Peak retention is ~2×(data+img copy); the extra copy is a micro-opt left
// unaddressed — cap 2 already fits the container budget with the copy.
const OCR_MAX_WAITERS = 2;
let _recognizeWaiters = 0;
let _recognizeStuck = false;
// When the current stuck window began (ms), for the self-heal cooldown.
let _stuckSince: number | null = null;
// Bumped on a self-heal rebuild. A recognize captures the generation when it
// starts; its gate handlers only mutate the shared counters if the generation
// is STILL current — so a wedged call that settles late (after a rebuild)
// can't corrupt the fresh gate (drive _recognizeWaiters negative / clear a new
// stuck window).
let _gateGeneration = 0;
// Well beyond the 120s recognize timeout so a still-computing inference has
// finished before we ever rebuild (see _maybeSelfHealOcr for why this makes
// the rebuild corruption-free).
const OCR_STUCK_COOLDOWN_MS = 300_000;

function recognizeWithTimeout(svc: any, img: any): Promise<any> {
  if (_recognizeStuck) {
    return Promise.reject(
      new Error(
        'OCR temporarily unavailable (a prior inference is still running); retry shortly'
      )
    );
  }
  if (_recognizeWaiters >= OCR_MAX_WAITERS) {
    return Promise.reject(
      new Error('OCR busy (queue full); retry shortly')
    );
  }
  _recognizeWaiters++;
  // Capture the gate generation at enqueue. If a self-heal rebuild happens
  // while this call is wedged, the generation bumps; this call's late-settling
  // handlers then see a stale generation and no-op, so they can't drive the
  // fresh _recognizeWaiters negative or clear a NEW stuck window.
  const myGeneration = _gateGeneration;
  // The gate tracks the REAL recognize; it settles on real completion/rejection
  // only, so svc.recognize is never entered concurrently.
  return new Promise((resolve, reject) => {
    // The timeout must measure INFERENCE time, not queue-wait: arm it only when
    // this unit's svc.recognize actually BEGINS (inside the gate .then), or a
    // caller that merely waited its turn behind a slow-but-healthy predecessor
    // would trip the timeout and wrongly set _recognizeStuck → a rolling global
    // OCR outage (Step-7 round-3). Attaching the timer inside the gate callback
    // starts the clock at execution, not enqueue.
    let timer: NodeJS.Timeout | undefined;
    const real = _recognizeGate.then(() => {
      timer = setTimeout(() => {
        if (myGeneration === _gateGeneration) {
          _recognizeStuck = true;
          _stuckSince = Date.now();
        }
        reject(
          new Error(
            `OCR recognize timed out after ${OCR_RECOGNIZE_TIMEOUT_MS}ms`
          )
        );
      }, OCR_RECOGNIZE_TIMEOUT_MS);
      return svc.recognize(img);
    });
    // Advance the gate only when THIS unit truly settles; that is also when its
    // buffer is released, the waiter slot frees, and any stuck state clears.
    // Guard on generation so a call that settles AFTER a self-heal rebuild
    // doesn't mutate the rebuilt gate's counters.
    const settle = () => {
      if (myGeneration !== _gateGeneration) return;
      _recognizeWaiters--;
      _recognizeStuck = false;
      _stuckSince = null;
    };
    _recognizeGate = real.then(settle, settle);
    // Caller view: settle on the real inference, or on the timeout armed above.
    // A timeout reject frees the CALLER but does NOT touch _recognizeGate, so
    // the session stays reserved until the real inference finishes.
    real.then(
      (r: any) => {
        if (timer) clearTimeout(timer);
        resolve(r);
      },
      (e: any) => {
        if (timer) clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * OCR an image buffer (JPEG/PNG/WEBP) and return the recognized text.
 * The first call initializes the ONNX sessions (~2s, ~175MB); subsequent
 * calls reuse the warm singleton. Calls are serialized (see _ocrChain).
 */
export async function ocrImage(buffer: Buffer): Promise<string> {
  const run = _ocrChain.then(() => _ocrImageInner(buffer));
  // Keep the chain alive even if this call rejects, so one bad image doesn't
  // wedge every later call. Swallow only on the chain copy, not the returned one.
  _ocrChain = run.catch(() => undefined);
  return run;
}

async function _ocrImageInner(buffer: Buffer): Promise<string> {
  const { default: sharp } = await import('sharp');
  const { svc, Image } = await getService();

  // Header-only read (no pixel decode) to reject oversized/pixel-bomb images
  // BEFORE allocating any raw buffer. limitInputPixels:false here is safe — we
  // are only reading the header, and we enforce our own tighter bound next.
  const meta = await sharp(buffer, { limitInputPixels: false }).metadata();
  const px = (meta.width || 0) * (meta.height || 0);
  // Non-shrink-on-load formats (PNG/WEBP/…) get the tighter full-decode cap so
  // the raw RGBA buffer can't blow the container; JPEG keeps the 30MP cap.
  const maxPx = effectiveMaxPixels(meta.format);
  if (px > maxPx) {
    throw new Error(
      `Image too large to OCR (${meta.width}×${meta.height}, ${(px / 1e6).toFixed(0)}MP > ${(maxPx / 1e6).toFixed(0)}MP cap for ${meta.format || 'image'}). Downscale and retry.`
    );
  }

  // Decode + downscale to raw RGBA. fit:'inside' + withoutEnlargement keeps
  // small scans untouched; large photos shrink (JPEG shrinks on load, so the
  // full-res buffer is never materialized). limitInputPixels is a backstop.
  const { data, info } = await sharp(buffer, {
    limitInputPixels: MAX_OCR_INPUT_PIXELS
  })
    .resize(MAX_OCR_SIDE, MAX_OCR_SIDE, {
      fit: 'inside',
      withoutEnlargement: true
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const img = new Image(info.width, info.height, 4, new Uint8Array(data));

  const results = await recognizeWithTimeout(svc, img);
  return results.map((r: any) => r.text || '').join('\n');
}

export interface OcrLine {
  text: string;
  // Box in the coordinate space of the (possibly downscaled) OCR image.
  box: { x: number; y: number; width: number; height: number };
  // The scale applied to the original (origWidth/ocrWidth) so a caller can map
  // a box back onto the full-res source for a sharper re-crop.
  scale: number;
}

/**
 * OCR that also returns each line's bounding box + the downscale factor, so a
 * caller (Tier-1 field recovery) can re-crop a specific line from the ORIGINAL
 * full-res image and re-OCR it in isolation for more px-per-digit.
 */
export async function ocrImageWithBoxes(
  buffer: Buffer
): Promise<{ lines: OcrLine[]; origWidth: number; origHeight: number }> {
  // Serialize through the SAME _ocrChain as ocrImage (Step-7 round-3): this
  // path's big sharp RGBA decode runs BEFORE recognizeWithTimeout's waiter
  // check, so without chaining, a burst of concurrent bills would each allocate
  // ~27-54MB pre-gate and OOM the container regardless of the recognize cap.
  // Chaining forces one decode+inference at a time (the batch just takes longer,
  // which is fine — same trade ocrImage already makes).
  const run = _ocrChain.then(() => _ocrImageWithBoxesInner(buffer));
  _ocrChain = run.catch(() => undefined);
  return run;
}

async function _ocrImageWithBoxesInner(
  buffer: Buffer
): Promise<{ lines: OcrLine[]; origWidth: number; origHeight: number }> {
  const { default: sharp } = await import('sharp');
  const { svc, Image } = await getService();

  const meta = await sharp(buffer, { limitInputPixels: false }).metadata();
  const origWidth = meta.width || 0;
  const origHeight = meta.height || 0;
  const maxPx = effectiveMaxPixels(meta.format);
  if (origWidth * origHeight > maxPx) {
    throw new Error(
      `Image too large to OCR (${origWidth}×${origHeight}, > ${(maxPx / 1e6).toFixed(0)}MP cap for ${meta.format || 'image'}).`
    );
  }

  const { data, info } = await sharp(buffer, {
    limitInputPixels: MAX_OCR_INPUT_PIXELS
  })
    .resize(MAX_OCR_SIDE, MAX_OCR_SIDE, {
      fit: 'inside',
      withoutEnlargement: true
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const img = new Image(info.width, info.height, 4, new Uint8Array(data));
  const results = await recognizeWithTimeout(svc, img);
  const scale = info.width ? origWidth / info.width : 1;
  const lines: OcrLine[] = results.map((r: any) => ({
    text: r.text || '',
    box: {
      x: r.box?.x || 0,
      y: r.box?.y || 0,
      width: r.box?.width || 0,
      height: r.box?.height || 0
    },
    scale
  }));
  return { lines, origWidth, origHeight };
}

/**
 * Tier-1 field recovery (§15). Given the original full-res image and a target
 * line's box (in OCR-image space) + scale, crop that band out of the ORIGINAL
 * at full resolution (isolated → many more px/digit), pad it, and re-OCR just
 * that crop. Returns the recovered text (may still be wrong; the caller
 * re-validates the checksum). MEASURED to recover dropped IBAN/RF digits.
 */
export async function recropAndOcr(
  originalBuffer: Buffer,
  line: OcrLine,
  padPx = 8
): Promise<string> {
  const { default: sharp } = await import('sharp');
  const meta = await sharp(originalBuffer, {
    limitInputPixels: false
  }).metadata();
  const W = meta.width || 0;
  const H = meta.height || 0;
  // Map the OCR-space box back to original-image pixels, then pad + clamp.
  const left = Math.max(0, Math.round(line.box.x * line.scale) - padPx);
  const top = Math.max(0, Math.round(line.box.y * line.scale) - padPx);
  const width = Math.min(
    W - left,
    Math.round(line.box.width * line.scale) + padPx * 2
  );
  const height = Math.min(
    H - top,
    Math.round(line.box.height * line.scale) + padPx * 2
  );
  if (width <= 0 || height <= 0) return '';

  const crop = await sharp(originalBuffer, {
    limitInputPixels: MAX_OCR_INPUT_PIXELS
  })
    .extract({ left, top, width, height })
    .png()
    .toBuffer();
  return ocrImage(crop);
}
