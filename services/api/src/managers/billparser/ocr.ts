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
  const rawDict = readFileSync(
    path.join(MODELS_DIR, 'greek_dict.txt'),
    'utf8'
  )
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
        const bitmap: any = await page.render({ scale: 2, render: 'bitmap' });
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

/**
 * OCR an image buffer (JPEG/PNG/WEBP) and return the recognized text.
 * The first call initializes the ONNX sessions (~2s, ~175MB); subsequent
 * calls reuse the warm singleton.
 */
export async function ocrImage(buffer: Buffer): Promise<string> {
  const { default: sharp } = await import('sharp');
  const { svc, Image } = await getService();

  // Decode to raw RGBA (sharp ships musl prebuilds — verified on NAS).
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const img = new Image(
    info.width,
    info.height,
    4,
    new Uint8Array(data)
  );

  const results = await svc.recognize(img);
  return results.map((r: any) => r.text || '').join('\n');
}
