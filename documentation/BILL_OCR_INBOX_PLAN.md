# Design — Bill OCR Import + Telegram Inbox

> Status: v3.2 — Slices 1–6 SHIPPED (see §16 for the commit trail and the post-ship
> audit). This document is now part design-of-record, part audit log: §1–§15 describe
> what was designed and built; **§16 records the 2026-07 audit of the shipped code (7
> fixes) and is the current state of play.**
>
> Architecture (OCR-in-api WASM, sharp build, memory, threads, saveMonthlyStatement bridge)
> is MEASURED on the real NAS. Remaining unverified items are flagged inline as UNVERIFIED.
> Every fact cites its source file:line or test run.
>
> **BRANCHING — do NOT build on `nas` directly.** Cut a feature branch off `nas`
> (e.g. `feat/bill-ocr-import`) and do all work there. This change touches money-
> critical paths (the saveMonthlyStatement bridge, RF/QR extraction, expense
> creation) and is expected to churn through regressions before it stabilises —
> keep `nas` (production) clean. Merge back only after each slice's full pre-merge
> gate (§9) is green on the live NAS. Never push regressions to `nas`.
>
> **REVIEWING THE BRANCH (it is NOT auto-live).** CI builds images ONLY on push to
> `nas` (`nas-ci.yml:9`), and `deploy:nas` targets the single production stack — so
> a feature branch produces no images and has no live URL by default. Review it via:
>   1. **UI — local dev server against NAS data** (the `ui-review-do-not-skip.md`
>      method; setup is in `stash@{0}` "local-dev LOCAL_UI_PROXY rewrite"): `yarn dev`
>      on port 8180 runs the BRANCH frontend with hot reload, proxying API/data to the
>      real NAS (read-only, env-gated, cannot write/break prod). Real Greek data,
>      seconds per change. GAP: backend is still NAS's `:nas` api, so branch BACKEND
>      changes (OCR route, parser, bridge) are NOT exercised here.
>   2. **Backend + full flow — local finch stack with a COPY of the real NAS DB**
>      (`FINCH_SETUP.md`): `finch compose up` builds ALL services from branch source and
>      runs the whole app locally. The only way to exercise the OCR/parser/bridge
>      end-to-end before merge; where the new E2E specs + manual OCR testing run.
>      **Seed it with your real data, not stubs:** NAS + local both run `mongo:4.4`
>      (verified), and the repo already has `mongodump --gzip --archive` (`dbbackup.js`).
>      One-time: `mongodump` the NAS `mredb` (~1MB, 10 collections — tiny) → `mongorestore`
>      into the local finch mongo. It's a COPY — the local DB is isolated; churn/break/wipe
>      it freely, the NAS is never touched. GOTCHA: thirdParties tokens (gmail/smtp/b2/
>      telegram) are `CIPHER_KEY`-encrypted (realmmanager.ts:195+); they decrypt-fail
>      locally unless you also copy NAS `CIPHER_KEY`/`CIPHER_IV_KEY` into local `.env`.
>      IRRELEVANT for OCR — bill parsing/expenses/bridge/rents touch no encrypted fields.
>   3. **Live NAS branch URL (heaviest, only if needed):** add the branch to
>      `nas-ci.yml` triggers (`:branch-<sha>` images) + a SECOND Portainer stack on a
>      different port with a DB copy. Real work + more RAM on the 8.2GB box — reserve
>      for stakeholder-style live review. Not recommended for normal iteration.
> Recommended: (1) for UI mocks/surfaces, (2) for OCR backend. Merging to `nas` is the
> ONLY thing that puts it on the real production URL — do that only when a slice is gated.

---

## 0. Requirements (from your messages across this conversation)

1. Import a scanned image/photo of a λογαριασμός (not just digital PDFs).
2. OCR it — RapidOCR/paddleocr.js won the benchmark.
3. Confirm/amend dialog before saving.
4. Handle "no δαπάνη" — let user create one in-flow.
5. Handle "wrong building" — dropdowns.
6. Route amount to tenant/owner correctly.
7. Batch support.
8. Provider templates with versioning (DEH, ΕΥΔΑΠ Αττικής, ΔΕΥΑ Τήνου, ΕΠΑ).
9. Assertions (date/month/already-paid/duplicate/anomaly/RF checksum).
10. Upload source to B2.
11. Forward bill to Telegram bot → dashboard notification → confirm → disappear.
12. Fine-tuning from amendments (answer: not runtime-feasible; see §7).

---

## 1. OCR Architecture (PROVEN — not proposed)

### What was tested end-to-end

| Stack | Result on real ΔΗΜΟΣ ΤΗΝΟΥ bill |
|-------|--------------------------------|
| `paddleocr` npm + `onnxruntime-web` WASM, Node.js | **7/7 critical fields** (amount, both RFs, account, due, period start/end) |
| RapidOCR Python (ground truth) | 7/7, marginally cleaner on noisy duplicate fields |

### Speed — MEASURED on the actual NAS (native x86, throwaway container, Test 3 + thread sweep)

| numThreads | OCR time | speedup |
|---|---|---|
| 1 | 55.5s | 1.0× |
| 2 | 32.3s | 1.7× |
| **4** | **21.0s** | **2.6×** |

**WASM multithreading WORKS in Node here** — this CONTRADICTS Microsoft's onnxruntime-web compatibility matrix ("Node.js single-threaded WASM only"). The threaded binaries (`ort-wasm-simd-threaded.*.wasm`) ship in the package and run fine under Node 20 in the Alpine container; `effective=4` confirmed the engine accepted the count, and all thread counts produced identical 112 lines (correctness intact). Verified by direct measurement, not docs.

**DECISION: `ort.env.wasm.numThreads = 4` in the OCR module** → ~21s/bill (idle box), zero infra change. This makes the glibc-base and sidecar options (whose only benefit was multi-threaded inference) **UNNECESSARY** — WASM in-process delivers 2.6× here. 21s is within the "30s is fine" threshold. Batch (async/inbox): at the idle-box 21s that's ~7 min for 20 bills; under production contention (~2× not 2.6×, ~28s/bill — see caveat below) closer to ~9-10 min. Either way it's background work, not a blocking request.

**Caveats (honest):** (1) the sweep had all 4 cores free — in production api shares 4 cores with 15 other containers, so real speedup under contention will be < 2.6× (conservatively ~2×). (2) Consider capping threads to leave headroom for concurrent api request handling (e.g. numThreads=2–3, not 4) so OCR doesn't monopolize the box during a bill run. Measure under real load before pinning the final value.

### Correct parameter set (empirically determined, source-verified)

```javascript
// Detection: PP-OCRv6_det_small.onnx
detection: {
  channelOrder: 'bgr',              // official training: BGR (PP-OCRv5_mobile_det.yml)
  mean: [123.675, 116.28, 103.53],  // ImageNet (NormalizeImage, predict_det.py)
  stdDeviation: [1/(0.229*255), 1/(0.224*255), 1/(0.225*255)],
  limitType: 'max',                 // utility.py default
  maxSideLength: 960,               // utility.py default
  boxScoreThreshold: 0.55,          // tuned from 0.6 for CamScanner scans
  unclipRatio: 1.6,                 // tuned from 1.5
}
// Recognition: el_PP-OCRv5_rec_mobile.onnx
recognition: {
  // mean/std = [127.5]/[1/127.5] (uniform) → channel order IRRELEVANT
  charactersDictionary: ['blank', ...greekChars, ' ']  // greekChars = 354 entries read from the rec model's ONNX `character` metadata key
}
// CLS angle classifier: DISABLED — garbles Greek (tested; model is Chinese-only)
```

### Why this runs in the existing Alpine containers (no Python sidecar) — ALL VERIFIED ON NAS

- `onnxruntime-web` is pure WASM — no libc linkage, no native addon. **VERIFIED**: installed + ran in a throwaway container built FROM the real api Alpine image (`node:20.17-alpine3.20`), linux/amd64, on the NAS itself. Loaded and produced correct Greek. musl is not a factor.
- **NAS arch = x86_64** (live Portainer `docker/info`: x86_64, 4 CPU, 8.2GB). `@img/sharp-linuxmusl-x64` is the correct prebuild.
- **D5 — sharp multi-stage build: VERIFIED PASS.** Built the full api Dockerfile for linux/amd64 with sharp+onnxruntime-web+paddleocr in a throwaway git worktree (real repo untouched). The `deps` stage `yarn workspaces focus --production` resolved `@img/sharp-linuxmusl-x64` + `@img/sharp-libvips-linuxmusl-x64` as **prebuilt binaries — no source compile, no `vips-dev` needed**; all three `require()` cleanly in the final image. `apk add build-base python3` (already in the Dockerfile) is sufficient. Sharp is a package.json-only add.
  - **NOTE (git history):** commit `8468bd06 "chore: remove unused sharp dependency (no native deps needed)"` deliberately removed sharp to keep api native-dep-free. Reintroducing it is safe (prebuild, no compile) but consciously reverses that decision — call it out in the PR.
  - **NOTE (canvas):** the build logs `canvas@2.11.2 couldn't be built` — this is PRE-EXISTING and benign (optional transitive of `pdfjs-dist`, already fails the same way in current production, unused by OCR). Not introduced here.
- Models: ~15MB total (7.5MB rec + 5MB det), committed to the repo (static inference weights, not secrets).
- **MEMORY — MEASURED ON NAS (native x86, no emulation). DECISION: raise api limit to 1G.**
  Per-stage RSS profile of a real ΔΗΜΟΣ ΤΗΝΟΥ OCR, in a throwaway container on the NAS:
  | Stage | RSS |
  |---|---|
  | node + imports | 64 MB |
  | ONNX sessions created | 239 MB (+175) |
  | after recognize (PEAK) | **273 MB** |

  Peak **273 MB** — comfortably under the current 500 MB limit. (Local Mac-under-QEMU inflated this to 429 MB; the native NAS figure is the real one.)
  - The +175MB is onnxruntime-web materializing the two ONNX models into WASM sessions (one-time). RESIDENT once OCR has run → api's steady state after first OCR is ~239MB, not the ~100MB no-OCR idle.
  - **Session MUST be a lazy singleton** — build `PaddleOcrService` once and reuse. Per-request `createInstance` re-pays the session cost and fragments. Warm singleton: each bill adds only ~34MB (image + inference scratch), freed between bills.
  - **Batch is memory-safe:** `parseBills` loops `for...of` with `await` — strictly sequential on one warm session. 5 or 20 bills peak the SAME as 1 (~273MB); memory does NOT stack by batch size. (Batch's real constraint is TIME — see the speed table — → async/inbox processing; plus the multer buffer stack, see §2.1.)
  - **DECISION: raise api's `deploy.resources.limits.memory` from 500M to 1G** in `docker-compose.microservices.prod.yml`. A limit is a CEILING not a reservation — idle api still uses ~100MB, post-OCR ~239MB; the 1G is headroom so an OCR spike + Mongo/Redis + concurrent request handling never approaches the cap. 273MB fits 500M for a single idle-box bill, but leaves little margin under production concurrency. NAS has 8.2GB; 1G for api is safe (idle usage is unchanged — the ceiling doesn't reserve RAM).

### Where it lives: `services/api` (in-process, no cross-service call)

NOT pdfgenerator — that was wrong. Reasons verified from code:

1. **Memory:** pdfgenerator is capped at 500MB and already runs Puppeteer/Chromium (~200-400MB during PDF render) — adding the measured ~273MB OCR peak on top risks OOM there. api has NO heavy binary deps (confirmed: `package.json` has zero puppeteer/chromium/canvas/sharp), idles ~100MB, and (with the 1G limit) the measured 273MB OCR peak fits with headroom.
2. **Ownership:** api already owns the entire bill pipeline (`parseBillPdf`, `parseBills`, `confirmBills`, providers, and the Telegram poller). OCR is an internal step of `parseBillPdf`, not a separate service's job.
3. **No HTTP round-trip:** the earlier plan had api POST-ing to pdfgenerator then continuing its own pipeline. That's pointless complexity for a function call.
4. **sharp does NOT exist in pdfgenerator** (checked `package.json` — deps are puppeteer, ejs, handlebars, multer, aws-sdk, no sharp). It must be added to whichever service does OCR. Adding to api: one line.

New deps added to `services/api/package.json`:
- `paddleocr` (PP-OCR pipeline: det preprocessing + CTC decode)
- `onnxruntime-web` (WASM inference — no native addon, no libc dep, runs on Alpine musl)
- `sharp` (image decode to raw RGBA — ships `@img/sharp-linuxmusl-x64` prebuilds)

Models (~15MB): `services/api/models/PP-OCRv6_det_small.onnx` + `el_PP-OCRv5_rec_mobile.onnx` + `greek_dict.txt`. Committed to repo (they're static inference weights, not secrets).

OCR is a module loaded lazily on first use (so it doesn't slow api boot or waste memory when not doing OCR): `services/api/src/managers/billparser/ocr.ts`.

---

## 2. API Changes (services/api)

### 2.1 New multer instance for bills (C5)

The existing `upload` multer + `verifyPdfContent` are shared with E9/AADE importer (`routes.ts:190,82`). Cannot loosen them.

**Solution:** a SEPARATE multer instance + magic-byte check, wired only to `/bills/parse`:

```typescript
const uploadBill = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },  // 10MB (photos are bigger than PDFs)
  fileFilter: (_req, file, cb) => {
    const allowed = ['application/pdf','image/jpeg','image/png','image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new ServiceError('Only PDF or image files allowed', 422));
  }
});

function verifyBillContent(req, res, next) {
  const files = req.file ? [req.file] : req.files || [];
  for (const file of files) {
    const h = file.buffer.slice(0, 12);   // D6: need 12 bytes — WEBP marker is at offset 8-11
    const isPdf = h.toString('ascii',0,4) === '%PDF';
    const isJpeg = h[0]===0xFF && h[1]===0xD8;
    const isPng = h[0]===0x89 && h.toString('ascii',1,4)==='PNG';
    const isWebp = h.toString('ascii',0,4)==='RIFF' && h.toString('ascii',8,12)==='WEBP';
    if (!isPdf && !isJpeg && !isPng && !isWebp) {
      return next(new ServiceError(`Invalid file: ${file.originalname}`, 422));
    }
  }
  next();
}
```
D6: the original `slice(0, 8)` made `isWebp` always false (start index 8 ≥ length 8 → empty string), so every WEBP the fileFilter admits would 422. `slice(0, 12)` fixes it.

Wiring: `billsRouter.post('/parse', uploadRateLimit, uploadBill.array('bills', 20), verifyBillContent, ...)`.
The E9 path (`occupantsRouter.post('/import-pdf', ...)`) continues using the old `upload` instance unchanged.

**Multer buffer stack (the batch memory vector — referenced from §1).** `memoryStorage` + `array('bills', 20)` holds ALL uploaded files in RAM simultaneously before processing. This is SEPARATE from and ADDITIVE to the OCR ~273MB. Phone photos are ~0.2–2MB (the test bill was 212KB) → 20 × 2MB ≈ 40MB, trivial. But at the 10MB-per-file cap, a worst-case 20×10MB = 200MB burst lands ON TOP of OCR → could approach the (raised) 1G limit under concurrency. Unlike the OCR session, this DOES scale with batch size. Mitigation: keep the per-file cap modest (6MB is plenty for a bill photo) OR lower the batch cap. This is the only batch-memory concern; the OCR session itself does not stack (§1).

### 2.1b Remove `hasAnyBillingId` precheck (blocker for fresh buildings)

`parseBills` (billmanager.ts:75-85) rejects with 422 if NO expense in the entire realm has a `billingId`. This was a guard against pointless parsing when matching was impossible. But with the new "no match → create expense from OCR" flow, a fresh building with zero billingIds must still be parseable — the user creates the expense (with the parsed billingId) AFTER seeing the OCR result.

**Fix:** Remove the precheck entirely. `findExpenseByBillingId` already returns `null` gracefully when nothing matches — the UI handles that case now instead of being blocked.

### 2.1c BillImportDialog needs all buildings (not just the prop)

Currently `BillImportDialog` receives a single `building` prop from `ExpenseList.js:1249`. But `findExpenseByBillingId` (billmanager.ts:31) searches ALL buildings in the realm — a parsed bill might match a DIFFERENT building than the one you're viewing. And the "no match" dropdown must list all buildings.

**Fix:** The dialog must `useQuery([QueryKeys.BUILDINGS], fetchBuildings)` to load all realm buildings for the dropdown. The `building` prop becomes the pre-selected default in the dropdown, not the only option. The parse response already returns `match.buildingId` / `match.buildingName` cross-building — this just surfaces it in the UI.

### 2.2 Modified `parseBillPdf` (billparser/index.ts)

```typescript
export async function parseBillPdf(buffer: Buffer): Promise<BillParseResult> {
  let text: string;
  const isPdf = buffer.slice(0,4).toString() === '%PDF';
  if (isPdf) {
    text = await extractTextFromPdf(buffer);  // existing pdfjs path
    if (text.replace(/\s/g,'').length < 50) {
      // Scanned PDF (image-only, no text layer). Slice 1: reject with guidance.
      // Slice 1b: extract embedded image via pdfjs getOperatorList or unpdf.
      return { success: false, error: 'Σαρωμένο PDF χωρίς κείμενο — ανεβάστε ως εικόνα (JPG/PNG)' };
    }
  } else {
    // Image file (JPEG/PNG/WEBP) — OCR in-process
    text = await ocrImage(buffer);  // local paddleocr + onnxruntime-web WASM
  }
  // rest of pipeline unchanged: detectProvider → parseDehBill / parseEydapBill / ...
}
```

`ocrImage` is a function in `services/api/src/managers/billparser/ocr.ts` — in-process, no HTTP call. Lazy-loaded on first use so it doesn't inflate api's boot memory. Uses `sharp` to decode image → raw RGBA, then `paddleocr` PaddleOcrService for det+rec.

**Scanned PDF handling (Slice 1b, follow-up):**
- `sharp` cannot decode PDFs (verified: `sharp.format.pdf.input = false`).
- `unpdf` (npm, v1.6.2) wraps pdfjs + canvas polyfill → renders pages to PNG buffer server-side. OR pdfjs `page.getOperatorList()` → extract embedded raw images without rendering. Either adds the scanned-PDF case.
- For Slice 1, the primary path is **direct image upload** (CamScanner/Telegram photos are JPEG). The "upload as image" guidance message is temporary and honest, not a silent failure.

### 2.3 Fix: return `paymentCode` to client (C1)

Currently `parseBills` omits `paymentCode` from the response (`billmanager.ts:139-151`); the confirm step then stores `null`. Fix: include `paymentCode` in the `parsed` object so the confirm flow can pass it through.

**How the QR works today (commit `2f79d56a`, verified):** the DEH bill's QR is rendered as a barcode FONT (not a bitmap), so decoding it from a digital PDF was impossible. Instead, the real QR was decoded ONCE from a bill image to learn its content = `RF_CODE + PAYMENT_CODE`, and the app now **regenerates** an identical QR with the `qrcode` package (`generateIrisQr`, `index.ts:63`). Verified: generated QR decodes to the same string as the bill's.

**QR for ALL providers — generation is universal, content is per-provider.** The `qrcode` machinery is provider-agnostic; only the encoded *content string* differs. DEH = `RF + paymentCode`. For each new provider (ΔΕΥΑ Τήνου, ΕΥΔΑΠ, ΕΠΑ) we must **decode its printed QR ONCE** (from the real scanned image — decoding scanned-image pixels IS feasible, unlike the PDF-font case) to learn what its QR encodes, then generate the same. ΔΕΥΑ Τήνου has no DEH-style `paymentCode` token (verified: DEH regex `/(\d{6,12}),(\d{2})\s+(\d)/` matches nothing in the fixture) — its QR content is likely RF-based, but **the exact content must be learned by decoding its real QR**, not assumed. This is a per-provider parser step: extract whatever fields that provider's QR encodes, then `generateIrisQr`-style regenerate.
- **UNVERIFIED / needs the real QR:** ΔΕΥΑ Τήνου + ΕΥΔΑΠ + ΕΠΑ QR content formats — decode one printed QR per provider to learn them. Blocks per-provider QR until the sample bills arrive.

### 2.4 Fix: generate QR even when unmatched (C2)

Currently `generateIrisQr` is only called inside `if (match)` (`billmanager.ts:111`). Move it outside so a QR is generated from the parsed payment fields regardless of expense match — the QR is about the payment reference, not the match. Each provider's parser supplies the content fields its QR needs (§2.3); generation then runs uniformly.

### 2.5 Fix: dates in UTC (C4)

`parseGreekDate` in `deh.ts:18` uses `new Date(year, month-1, day)` (LOCAL time). Replace with `new Date(Date.UTC(year, month-1, day))`. Same fix in all new provider parsers. This prevents the term-landing-on-wrong-month bug on Athens summer.

### 2.6 `saveMonthlyStatement` bridge (C6 — the dangerous one)

When the user toggles "Χρέωση ενοικιαστών" on confirm, the server must call `saveMonthlyStatement`. But that function is a **full-term replace** — it strips ALL monthlyCharges for the term and rebuilds from what you pass.

**Solution:** `saveMonthlyStatement` is an express route handler (`(req, res)`, `buildingmanager.ts:2911`) — a 400-line function with owner-settlement carry-forward, orphan reattach, `_recomputeVacantOwnerCharges`, and `_recomputeTenantsForProperty`. Cannot be refactored without risk. Cannot be called as a function.

Use the same pattern as the lease-expiry cron (`leaseExpiryScanner.ts:250-280`): **internal HTTP self-call with a minted service token.**

```typescript
// In confirmBills, when chargeThisMonth is true:
// 1. Read building's existing expense entries for the term.
//    saveMonthlyStatement expects ONE entry per expense with the FULL amount
//    (it recomputes per-unit splits itself). So we read `inputAmount` from
//    any unit's monthlyCharge for that term — `inputAmount` is the landlord-typed
//    full figure preserved across recompute (written at buildingmanager.ts:3056,
//    the field added in commit 22316220 to stop variable amounts eroding to zero).
//    NOTE: the entry does NOT need `allocationMethod` — the engine's entry loop
//    (buildingmanager.ts:3010-3013) falls back to `buildingExpense.allocationMethod`
//    (then 'equal') when the entry omits it, and applies the fixed+amount-0→equal
//    correction (~3016) itself. So omitting it is correct, not a bug.
// D7 FIX: the per-term strip (buildingmanager.ts:~3005-3013) is SOURCE-BLIND — it
// pulls EVERY monthlyCharge for the term (fixed AND variable). So the rebuild set
// must contain ALL persisted expense charges for the term, not just variable ones.
// Filtering `e.amount === 0` would drop fixed-amount charges → they get stripped and
// never re-added → silent data loss. Gather from the persisted monthlyCharges directly,
// grouped by expenseId, reading inputAmount (the full pre-split figure) or amount.
const building = await Collections.Building.findOne({_id: buildingId, realmId}).lean();
const byExpense = new Map(); // expenseId → full amount
for (const unit of (building.units || [])) {
  for (const c of (unit.monthlyCharges || [])) {
    if (c.term !== term) continue;
    const eid = String(c.expenseId);
    // inputAmount is the landlord-typed full figure; for fixed expenses it equals amount.
    // We take the FIRST unit's inputAmount per expense (it's the same building-wide figure).
    if (!byExpense.has(eid)) {
      byExpense.set(eid, { amount: c.inputAmount || c.amount, description: c.description });
    }
  }
}
const existingEntries = [...byExpense.entries()].map(([expenseId, v]) => ({
  expenseId, amount: v.amount, description: v.description
}));
// 2. Merge (add/replace) the bill's expense into the set
const billEntry = { expenseId, amount: totalAmount, description: expenseName };
const merged = [...existingEntries.filter(e => e.expenseId !== expenseId), billEntry];
// 3. Internal POST — same pattern as leaseExpiryScanner (line 250-280)
const serviceToken = await Service.getInstance().createServiceToken('administrator', realmId);
await axios.post(`http://localhost:${API_PORT}/buildings/${buildingId}/monthly-statement`, {
  term, expenses: merged
}, { headers: { authorization: `Bearer ${serviceToken}`, organizationid: realmId } });
```

**Why this is correct:** `saveMonthlyStatement` strips ALL monthlyCharges for the term then rebuilds from entries (buildingmanager.ts:~3005-3013 strip, ~3056 write). Each entry carries the FULL expense amount; the engine splits per-unit via `computeBuildingChargeForProperty`. By reading `inputAmount` from the persisted charges, we recover what the landlord originally typed, not the per-unit slice. Passing the full set (existing + new bill) ensures siblings aren't clobbered.

This reuses the ENTIRE allocation/owner/vacant engine (all 400 lines) without touching it. The minted service token satisfies `needAccessToken` + `checkOrganization` middleware exactly as the lease-expiry cron does. `API_PORT` from `process.env.PORT` (same env var the service listens on, `docker-compose: PORT=$API_PORT`).

---

## 3. Provider Templates + Versioning

### Structure: `services/api/src/managers/billparser/providers/`

```
providers/
  deh/       v2024.ts (moved from current deh.ts), index.ts
  eydap-attikis/  v2024.ts, index.ts
  deuaTinou/ v2024.ts, index.ts   ← the bill we tested
  epa/       v2024.ts, index.ts
```

Each version exports `{detect(text):boolean, parse(text):ParsedBill|null}`.
Provider `index.ts` tries newest→oldest, returns first success.

`detectProvider` in `billparser/index.ts` adds markers:
```typescript
{ provider:'deuaTinou', patterns:[/ΔΗΜΟΣ ΤΗΝΟΥ/i, /dimostinou\.gr/i, /ΥΠΗΡΕΣΙΑ ΥΔΡΕΥΣΗΣ[\s\S]*ΤΗΝΟ/i] }
// NOTE: the 3rd marker MUST use [\s\S]* not .* — verified against the real fixture,
// those two tokens are on SEPARATE OCR lines (same line-break trap as the field regexes).
// The first two markers match on their own; this is defense-in-depth.
```

**CRITICAL — OCR output is LINE-BROKEN, not "label VALUE" on one line.** Each detected text box is its own line in the OCR output. Verified against `services/api/src/__tests__/fixtures/deuaTinou-ocr-sample.txt` by the adversarial pass: the label `ΠΛΗΡΩΤΕΟ ΠΟΣΟ:` and the amount, the label `ΑΡΙΘ. ΛΟΓΑΡΙΑΣΜΟΥ` and the account number, `ΗΜ. ΛΗΞΗΣ` and the due date are ALL on separate lines (the columnar bill layout flattens into label-lines then value-lines). Single-line regexes with `\s+` or `.*?` between label and value return `undefined`. Regexes MUST cross newlines with `[\s\S]*?`.

The ΔΕΥΑ Τήνου parser regexes, corrected + re-verified against the real `services/api/src/__tests__/fixtures/deuaTinou-ocr-sample.txt`:
- Amount: `/ΠΛΗΡΩΤΕΟ ΠΟΣΟ:[\s\S]*?([\d.]+,\d{2})\s*€/` (→ `15,67`) — verified matches
- Account: `/ΑΡΙΘ\.\s*ΛΟΓΑΡΙΑΣΜΟΥ[\s\S]*?(\d{9,})/` (→ `999000328758`) — D2 fix, crosses lines. Fragile: grabs first 9+ digit run after label.
- Period: `/ΑΠΟ:[\s\S]*?(\d{2}\/\d{2}\/\d{4})[\s\S]*?ΕΩΣ:[\s\S]*?(\d{2}\/\d{2}\/\d{4})/` — verified
- Due: `/ΗΜ\.\s*ΛΗΞΗΣ[\s\S]*?(\d{2}\/\d{2}\/\d{4})/` (→ `23/07/2026`) — D3 fix, was `.*?` (fails on newline)

### RF code selection — by LABEL, not by checksum (D1, the money-critical fix)

The bill has TWO RF codes and BOTH pass mod-97:
- `RF43…` = ΚΩΔΙΚΟΣ ΗΛΕΚΤΡΟΝΙΚΗΣ ΠΛΗΡΩΜΗΣ (**the payment code — this is what the IRIS QR needs**)
- `RF95…` = ΚΩΔΙΚΟΣ ΑΝΑΘΕΣΗΣ ΠΑΓΙΑΣ ΕΝΤΟΛΗΣ (standing-order mandate — WRONG for a one-off payment)

**"Take the first valid checksum" returns RF95 — the wrong one — routing the payment to the standing-order mandate.** Checksum cannot disambiguate (both valid). The RF MUST be selected by its label:

```typescript
// Anchor to the RF token itself (RF + 2 check digits + up to 21 base36 chars),
// stopping at whitespace/line boundary so it doesn't swallow the next line's digits.
// Then pick the one that follows the ΗΛΕΚΤΡΟΝΙΚΗΣ ΠΛΗΡΩΜΗΣ label.
const RF_TOKEN = /RF\d{2}[\dA-Z\s]{0,30}/g;   // capture with embedded spaces (OCR groups digits)
function extractPaymentRf(text: string): string | undefined {
  // Find the payment-code label, take the FIRST valid RF token AFTER it
  const anchor = text.search(/ΗΛΕΚΤΡΟΝΙΚΗΣ\s*ΠΛΗΡΩΜΗΣ/);
  const scope = anchor >= 0 ? text.slice(anchor) : text;
  for (const m of scope.matchAll(RF_TOKEN)) {
    const cleaned = m[0].replace(/\s/g,'');
    if (rfValid(cleaned)) return cleaned;
  }
  return undefined;
}
```

RF mod-97 checksum (tested — VALID for clean RF43, INVALID for the dropped-zero corruption):
```typescript
function rfValid(rf: string): boolean {
  const s = rf.replace(/\s/g,'').toUpperCase();
  if (!/^RF\d{2}[0-9A-Z]+$/.test(s)) return false;
  const rearr = s.slice(4) + s.slice(0,4);
  let num = '';
  for (const ch of rearr) num += /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0)-55);
  let rem = 0;
  for (const d of num) rem = (rem*10 + Number(d)) % 97;
  return rem === 1;
}
```
Checksum's role: reject OCR-corrupted instances (dropped digit), NOT choose between two valid codes — that's the label's job.

### Refactor caveat (D9)

Moving `deh.ts` → `providers/deh/v2024.ts`: `billparser/index.ts:3` imports it (prod, clean), BUT `services/api/src/__tests__/billparser.test.js:1` imports `../managers/billparser/deh.js` directly (20+ call sites). The refactor MUST update that test's import path OR leave a `deh.js` re-export shim, or the regression gate breaks.

---

## 4. FileDropZone Changes

Four edits (identified by reading `file-drop-zone.js` line-by-line):

1. **`handleDrop` filter** (line 42-43): replace `.endsWith('.pdf')` with extension check against the `accept` prop.
2. **`accept` prop default**: stays `.pdf` (other callers unaffected); BillImportDialog passes `.pdf,.jpg,.jpeg,.png,.webp`.
3. **Label strings** (lines 113-116): parameterize with a `dropLabel` prop or check accept to show "PDF / εικόνες" instead of "PDF files."
4. **Icon**: optionally show `LuImage` alongside `LuFileUp` when images are accepted.

---

## 5. Confirm/Amend Surface (the "no match" flow)

### What exists today (BillImportDialog.js)

- Matched bills show a read-only `ResultCard` with parsed fields + QR + optional "replace existing" toggle.
- Unmatched bills show a static amber warning: "No matching expense found. Add a Billing ID to an expense first." **Dead end — user must leave, fix the expense, come back.**
- The confirm button only includes matched results (`results.filter(r => r.success && r.match)`, line 170).

### Server match — exact billingId NOW; element-scoring DEFERRED to Slice 3 (verified rationale)

VERIFIED: the only existing parser (DEH) emits `billingId, amount, periodStart/End, rfCode,
paymentCode` — NO address/ΑΦΜ/name. `findExpenseByBillingId` matches exact normalized
billingId, which works for DEH. **Multi-element scoring here would have almost nothing to
score on until the Slice-3 provider parsers emit a richer element bag** — building it now =
speculative code scoring on fields that don't exist. So:
- **Now (Slice 2):** keep exact-billingId match (works); when it hits, PRE-SELECT that
  building+expense in the confirm dropdowns. When it misses → the no-match flow below.
- **Slice 3:** as each parser starts emitting address/ΑΦΜ/name, add scored pre-selection
  (same element bag that feeds the receipt-match §15). Deferred, not dropped.

VERIFIED sequencing correction: `confirmBills` 404s if the `expenseId` doesn't exist on the
building (billmanager.ts:219). So "persist an unmatched bill" is IMPOSSIBLE without first
creating the expense. ⇒ the create-expense-inline flow is the ENABLER of the no-match path,
not a separate later step. Slice 2's real deliverable is the no-match confirm flow itself.

### What changes in the ResultCard (U2)

1. **Building dropdown** — pre-selected to the matched/best-scored building; all realm
   buildings selectable (dialog must load them — §2.1c).
2. **Expense dropdown** — expenses on the selected building, best candidate pre-selected;
   plus "➕ Δημιουργία νέας δαπάνης".
3. **All parsed fields editable** (amount, period, dates; RF/IBAN checksum-flagged) so OCR
   errors are fixed before confirm.
4. **"Χρέωση ενοικιαστών" toggle** — ON: after the Bill doc is written, also run the
   `saveMonthlyStatement` bridge (§2.6). OFF: Bill record only.
5. **Inline assertions** (§7) as colored badges.
6. Once building+expense are set, the card is confirmable.

### "➕ Νέα δαπάνη" — REUSE the existing ExpenseFormDialog VERBATIM (do NOT redraw it)

Choosing "➕" opens the **actual `ExpenseFormDialog` component** (ExpenseList.js:315-918),
**unchanged**, with ALL its existing controls — verified field set:
`name, type (11-enum), amount, allocationMethod, single-unit picker, customAllocations
table, isRecurring, startFromCurrentMonth, trackOwnerExpense, chargeOwnerWhenVacant,
ownerAmount, notes, billingId`. **It is NOT a new/simplified form** — that would be slop
and a maintenance fork. The only thing Slice 2 adds is opening it with a pre-filled
`expense` prop (no `_id` → add mode → `addBuildingExpense`, branch at ExpenseList.js:582).
Pre-filled SUGGESTIONS (user can change any): name=provider label, type=provider→type map,
allocationMethod='equal', billingId=parsed, amount=0, isRecurring=true,
chargeOwnerWhenVacant=true. Every OTHER control is exactly as the dialog renders today.

### Extract ExpenseFormDialog for reuse (refactor — D13-safe)

To open it from BillImportDialog it must be importable, so move `ExpenseFormDialog` into
`components/buildings/ExpenseFormDialog.js` and have BOTH ExpenseList and BillImportDialog
import it. This is a MOVE, not a rewrite — the component body is unchanged.
**D13:** module-level consts `expenseTypes` (ExpenseList.js:172), `allocationMethods` (:186),
`ALLOCATION_DESCRIPTIONS` (:198) are ALSO used by ExpenseList's table render (:1068/:1081/
:1088) → put them in a shared module both import, don't move them INTO the dialog file.
Guard with a jest/RTL smoke + manual screenshot (the extraction must render byte-identical
to today's dialog before pre-fill is added).

### Multi-page / multi-image documents (one bill = several pages)

Verified state (Slice 2):
- **Digital-PDF multi-page: WORKS** — `extractTextFromPdf` loops `numPages`, joins with
  `--- PAGE BREAK ---` (index.ts:40).
- **Single image (JPEG/PNG/WEBP): WORKS** — the primary path; how CamScanner/Telegram bills
  actually arrive (verified: real bills were JPEGs). `ocrImage` handles it.
- **Scanned/image-only PDF with N pages: BUILT (Slice 2f).** CamScanner exports PDFs by
  default — this is a PRIMARY path, not an edge case. Implementation: `parseBillPdf` detects
  the empty text layer (<50 chars) → `rasterizePdfToImages` renders every page via
  **`@hyzyla/pdfium` (PURE WASM, no native addon, no libc dep — same class as
  onnxruntime-web, runs on the existing Alpine/musl image; VERIFIED in-container it
  rasterizes a page → 854KB PNG)**. sharp wraps each pdfium BGRA bitmap → PNG → `ocrImage`,
  page texts joined with `--- PAGE BREAK ---`. (`sharp` itself can't decode PDF — its musl
  libvips lacks poppler — which is why pdfium does the rasterization.)
- **PROD BUG FOUND + FIXED along the way:** the api Dockerfile copied `dist` + `scripts` but
  NOT `services/api/models` — so the OCR path (Slice 1, already committed) would ENOENT on
  the models in production. Added `COPY services/api/models` to the final stage. The models
  are git-tracked (~17MB), so CI builds them in.

---

## 6. Telegram Inbox + Notification Bell

### 6.1 Inbound poller — `services/api/src/jobs/telegramInboxScanner.ts`

Shares the STRUCTURAL pattern of `leaseExpiryScanner.ts` (interval + `.unref()` + re-entrancy guard + `start/stop` exports wired in `index.ts:34`), but NOT its cadence:
- **D10:** `setInterval(60_000)` — 60s, NOT the scanner's hourly tick, and it must NOT copy the scanner's once-per-UTC-day short-circuit (`leaseExpiryScanner.ts:508`), which would poll once per day and defeat the inbox.
- `startTelegramInboxCron()` exported, wired in `index.ts` alongside `startLeaseExpiryCron()`.
- Reads `realm.thirdParties.telegram.botToken` via `Crypto.decrypt` from `@microrealestate/common` (confirmed exported + importable in api; emailer already uses it in `telegram.ts:1,18`).
- `getUpdates?offset=<last+1>&allowed_updates=["message"]` — offset persisted in a `TelegramOffset` collection (single doc per realm).
- For each `document`/`photo` message:
  - Download file via `getFile` → `https://api.telegram.org/file/bot{token}/{path}`.
  - Route to the extract-parse-assert pipeline (§2.2 + §3).
  - Write an `InboxItem` doc (see below).
- Maps `message.chat.id` → realm's `adminChatId` to determine which realm owns the message.
- Single-replica assumption documented (api has no `replicas:` in prod compose).

**D8 — new collections need full registration (not just a schema shape):**
Both `TelegramOffset` and `InboxItem` must follow the codebase convention:
1. Create `services/common/src/collections/telegramOffset.ts` + `inboxItem.ts`, each ending `export default mongoose.model<CollectionTypes.X>('X', Schema)` (cf. `bill.ts:45`).
2. Export both from `services/common/src/collections/index.ts` (one export line each, cf. lines 3-12).
3. Add `CollectionTypes.TelegramOffset` + `CollectionTypes.InboxItem` to `types/src/common/collections.ts`.

### 6.2 InboxItem collection

```typescript
{
  realmId: String,
  source: { type: String, enum: ['telegram', 'upload'] },
  status: { type: String, enum: ['pending', 'confirmed', 'dismissed'], default: 'pending' },
  parsed: {
    provider, billingId, totalAmount, periodStart, periodEnd,
    issueDate, dueDate, rfCode, paymentCode, ocrText
  },
  suggestedMatch: { buildingId, buildingName, expenseId, expenseName } | null,
  warnings: [{ level, code, message }],
  ocrConfidence: Number,
  sourceFileName: String,
  telegramMessageId: Number,
  telegramFileId: String,
  irisCodeBase64: String,
  createdDate: Date,   // convention: createdDate/updatedDate + manual new Date() — matches all 11 collections (bill.ts:33-34); NOT createdAt/Date.now (zero precedent in codebase)
  updatedDate: Date
}
```
Set `createdDate: new Date()` explicitly on insert (the codebase pattern — no schema `default`).
Index: `{realmId, status}`. **D11 — TTL:** a native Mongo TTL index expires ALL docs regardless of status, so "30d on pending only" requires a `partialFilterExpression`. This would be the codebase's FIRST TTL index (grep: no `expireAfterSeconds`/`expires` precedent):
```typescript
InboxItemSchema.index({ createdDate: 1 }, {
  expireAfterSeconds: 2592000,             // 30d
  partialFilterExpression: { status: 'pending' }
});
```

### 6.3 Inbox API routes

- `GET /inbox` — returns pending InboxItems for the realm.
- `POST /inbox/:id/confirm` — body: `{buildingId, expenseId, [amended fields], chargeThisMonth}`. Creates Bill + optionally `saveMonthlyStatement` → deletes InboxItem.
- `POST /inbox/:id/dismiss` — deletes the InboxItem.
- Add `INBOX: 'inbox'` to `QueryKeys`.

### 6.4 Notification bell — `components/InboxBell.js` in Layout.js

- Location: `Layout.js:38`, the `flex items-center` row, left of `<OrganizationMenu/>`.
- `useQuery([QueryKeys.INBOX], fetchInbox, {refetchInterval: 60_000})` — matches poller cadence.
- Bell icon + badge count (hidden at 0). Click → Popover.
- Popover shows the same confirm/amend surface as §5 — one card per InboxItem. Confirm/dismiss removes the card (exit animation); invalidates `[INBOX]`+`[DASHBOARD]`+`[BUILDINGS]`+`[RENTS]`.

---

## 7. Assertions — `billparser/assertions.ts`

Returns `[{level:'block'|'warn', code, message}]`:
- `block` — RF mod-97 checksum INVALID (OCR digit slip — cannot generate correct QR).
- `warn` — duplicate `{expenseId, term}` (existing Bill doc found). NOTE: this is a PRE-confirm warning only; the hard guard already exists — `confirmBills` returns 409 on the `{realmId,buildingId,expenseId,term}` unique index (billmanager.ts:340) and the parse step already surfaces `existingAmount` (billmanager.ts:132,160). The assertion just surfaces it earlier with a replace toggle; do NOT reimplement the block.
- `warn` — due date in past ("Εκπρόθεσμος").
- `warn` — amount > 2× or < 0.3× mean of last 4 Bills for same expense.
- `warn` — period gap/overlap vs previous Bill for same expense.
- `warn` — bill period maps to a past frozen rent term (charging rewrites history).
- `warn` — expense soft-deleted (`endTerm < currentTerm`).

---

## 8. B2 Upload on Confirm

**CORRECTION — the "reuse pdfgenerator's upload endpoint" idea does NOT work; that endpoint does not exist.** Verified:
- `pdfgenerator`'s `uploadFile(b2Config, {file:{path}, fileName, url})` (`s3.ts:42`) is an INTERNAL function taking a **disk path**, called only inside pdfgenerator's own PDF-generation flow. There is NO generic "POST a file → B2" HTTP route.
- The only api→pdfgenerator calls today are `DELETE /documents/:ids` (`occupantmanager.ts:1773`) and `/documents/reconcile-storage` — neither uploads a caller-supplied file. api never POSTs a file to pdfgenerator.

So the bill source (a multer buffer in api's memory) cannot be handed to pdfgenerator for B2 upload without new plumbing. **Two real options:**
- **(A) api uploads to B2 directly.** api already has `CIPHER_KEY`/`CIPHER_IV_KEY` (compose env) and reads `realm.thirdParties`, so it can decrypt the B2 creds and use the AWS SDK (already a dep tree member via other services) to `putObject` itself. Self-contained, no new pdfgenerator route.
- **(B) add a new upload route to pdfgenerator** (`POST /documents/upload`, multer → `uploadFile`) and have api forward the buffer. More moving parts + an HTTP hop.

DECISION: **(A)** — api uploads directly (fewer parts, no cross-service file transfer). On confirm, if `realm.thirdParties.b2?.selected`: upload source + QR PNG → set Bill's `pdfUrl`/`irisCodeUrl` to B2 URLs, clear inline `irisCodeBase64`. Else keep the current inline data-URI behavior (graceful, not a gate). **UNVERIFIED:** that the AWS SDK is reachable from api's dependency tree — confirm before building Slice 5 (api's `package.json` may need `aws-sdk` added, like pdfgenerator has it).

---

## 9. Testing (per CLAUDE.md "nothing is done until Playwright drives it on NAS")

### Existing tests that must stay green (regression gate)
- `billparser.test.js` (DEH unit, string fixtures)
- `billparser-integration.test.js` (real PDF, skip-if-absent)
- `buildingCharges*.test.js`, `expenseBreakdown.test.js` (allocation engine)
- E2E: `48_building_expense_panel`, `50_owner_expenses_paid_tile`, `01_expense_edit`

### New tests per slice

**Slice 1 (image import + OCR):**
- UNIT: each provider parser with real OCR text fixtures + UTC date assertions.
- UNIT: RF mod-97 validator (valid + corrupted table).
- INTEGRATION: image buffer → parseBillPdf → correct fields (with `ocrImage` stubbed to return captured OCR text, so the parser is tested without running WASM).
- INTEGRATION: `ocrImage(buffer)` in-process (real image → real WASM inference → correct text).
- E2E `62_bill_import_image.spec.ts`: upload real CamScanner image → ResultCard renders correct Greek fields.

**Slice 2 (no-match + charge bridge):**
- UNIT (CRITICAL C6): seed building with 2 existing variable charges, bridge a 3rd, assert ALL THREE in emitted payload.
- INTEGRATION: confirm-with-charge → Bill doc + monthlyCharges written + term UTC-correct.
- E2E `63_bill_confirm_creates_expense.spec.ts`: "no match" → pick building → "➕ Νέα δαπάνη" → verify pre-fill → confirm with charge → assert breakdown reflects the share.
- E2E regression: confirm SECOND bill same term → first charge still present.

**Slice 3 (providers):** per-provider unit from real OCR fixtures.

**Slice 4 (Telegram inbox + bell):**
- UNIT: `getUpdates` offset advance + routing logic with mocked Telegram API.
- INTEGRATION: `GET /inbox`, `POST /inbox/:id/confirm`, `POST /inbox/:id/dismiss`.
- E2E `64_inbox_bell.spec.ts`: seed InboxItem via mongoExec → bell badge shows '1' → confirm → badge disappears.
- DOCUMENTED SEAM: real Telegram inbound manually verified once, not in automated suite.

**Slice 5 (B2):** integration test with mocked S3 → `pdfUrl`/`irisCodeUrl` populated.

### Pre-merge gate (every slice)
1. Full jest green (node@20, 0 failed). **Baseline as of 2026-07-31: 875 passed / 17
   skipped / 892 total, 54 suites passed + 1 skipped suite (e9parser /tmp fixtures).**
   Do not copy an older figure from CLAUDE.md — it records ~644 (July 1) and is stale;
   read the actual run. A count that DROPS is a deleted test, not a pass.
2. `yarn workspace @microrealestate/landlord build` (catches import errors dev-mode
   misses). **The workspace name is `@microrealestate/landlord`** — plain `landlord`
   makes yarn exit with a *usage error* whose tail looks nothing like a build failure,
   so a scripted `tail -5` on the log reads as "fine". Always assert `EXIT=0` from the
   yarn process itself, never eyeball the tail.
3. Deploy to NAS, verify container revision via Portainer.
4. New specs + shared expense specs green on live NAS.
5. Manual Greek spot-check (`/landlord/el/`) — screenshot and READ it
   (`ui-review-do-not-skip.md`); a green suite is not a UI review.

---

## 10. UI Approval Gate (steering Rule 6)

> "ALWAYS show the proposed change as an ASCII or HTML render BEFORE writing code."
> "Build it then show a screenshot" is the banned anti-pattern.

Surfaces requiring approved mocks before code:

| # | Surface | File(s) |
|---|---------|---------|
| U1 | FileDropZone updated labels + image accept | `file-drop-zone.js` |
| U2 | ResultCard "no match" state (building/expense dropdowns, "➕ Νέα δαπάνη", editable fields, charge toggle, assertion badges) | `BillImportDialog.js` |
| U3 | ExpenseFormDialog pre-filled from OCR (reused component, new context) | extracted `ExpenseFormDialog.js` |
| U4 | Notification bell + badge in top bar | `Layout.js` + new `InboxBell.js` |
| U5 | Bell popover (InboxItem cards, confirm/dismiss, disappear animation) | `InboxBell.js` |

Process: ASCII/HTML mock → your approval → code the approved version → tests → Greek UI review fan-out.

---

## 11. Sequencing (independently shippable slices)

Status column added 2026-07-31 — see §16.1 for the commit trail.

1. ✅ **Slice 1: Image import + OCR** — api in-process OCR (paddleocr+WASM), api accepts images (new multer), FileDropZone accepts images, `hasAnyBillingId` precheck removed. Ship → you can drop a photo into "Εισαγωγή Λογαριασμού" and it parses.
2. ✅ **Slice 2: No-match flow + charge bridge** — confirm/amend surface, ExpenseFormDialog extraction, `saveMonthlyStatement` bridge.
3. ⛔ **Slice 3: Providers** — **NOT blocked. NOT started.** See §17: the real samples have existed since 2026-07-26 (`logariasmoi.pdf`, 14 pages) and were already OCR'd clean by this project's own pipeline. They now live OUTSIDE the repo at `~/mre-pii-backup-2026-08-01/real-bill-samples/bill-samples/` (§17.4 — they are a live account's personal data). ΕΥΔΑΠ ground truth is `ocr-out/page-09.txt`. ΕΠΑ is genuinely absent from the samples; **NOVA (telecoms) is present and was never in the plan.** Only `deh.ts` exists — there is no `providers/` directory.
4. ✅ **Slice 4: Telegram inbox + bell** — poller, InboxItem, bell UI.
5. ✅ **Slice 5: B2 archival** — upload source + QR on confirm.
6. ✅ **Slice 6: Απόδειξη OCR + match-to-pending** — see §15.

---

## 14b. DISCOVERED PRE-EXISTING BUG (out of this branch's scope) — saveMonthlyStatement clobbers repair charges

Status: **CONFIRMED end-to-end with a REAL occupied tenancy + REAL API repair. Pre-existing;
reproduces via the normal `/monthly-statement` endpoint with zero bill-OCR involvement.**

CODE FACT: `saveMonthlyStatement`'s per-term strip (buildingmanager.ts:2997) is source-blind
— `unit.monthlyCharges.filter(c => c.term === term)` pulls EVERY charge for the term, and
repair tenant-shares ARE written to `unit.monthlyCharges` as `{term, repairId}` (:5700). The
save tail re-fires `_recomputeVacantOwnerCharges` + `_recomputeTenantsForProperty` but NOT
`redistributeRepairsForProperties`, so a stripped repair charge is never rebuilt.

REPRO (local NAS-copy, real data — tenant `blah blah` occupying unit 5 of ΟΔΟΣ ΕΨΙΛΟΝ 28,
lease covers Nov 2026):
- step 0: repair charges on term 2026-11 = **0**
- step 1: `POST /buildings/:id/repairs` (€90, split, tenantShare 100, chargeTerm 2026-11) →
  repair charges = **1** (real charge materialised on the occupied unit)
- step 2: `POST /buildings/:id/monthly-statement` (Νερό, same term, HTTP 200) →
  repair charges = **0** ← CLOBBERED, not rebuilt.
This is the exact call the BuildingExpensePanel "save monthly statement" button makes. So
**recording a monthly statement on a month that has a tenant-charged repair silently deletes
the repair charge today**, entirely independent of the bill-OCR feature.

(Earlier this doc said "suspected/retracted" after a synthetic-seed test created 0 charges —
the miss was that a repair tenant-share only materialises on an OCCUPIED unit; with a real
occupied tenancy it does, and the clobber reproduces. Now proven.)

NOT this branch's to fix — it's shared core money code, and the rebuild
(`redistributeRepairsForProperties`) has intricate freeze-guards (euro-vanish/double-count if
re-fired wrong). Needs its own investigation + six-pass review. My H1 fix ensures the BRIDGE
never sends malformed `expenseId:'null'`; on the repair-strip axis the bridge is exactly as
(un)safe as the existing UI. FLAGGED as a discovered pre-existing production bug.

## 15. Slice 6 — Απόδειξη (payment receipt) OCR + suggested match

> User requirement: "When I pay a bill I also need to match it with the απόδειξη.
> OCR the receipt, present a menu of PENDING pdfs (those with no matched receipt)
> + the main elements it recognised, soft-suggest the match, save/move them
> together in cloud storage. Keep two (or more, for installments) records. Don't
> expect miracles — SUGGEST. The panel must look good, not AI slop."

### What already exists (verified — build ON this, don't duplicate)
- **"Αποδείξεις Πληρωμής" button already renders** next to "Εισαγωγή Λογαριασμού"
  (`ExpenseList.js`) → opens `PaymentReceiptDialog`.
- `POST /bills/payment-receipt` (`billmanager.parsePaymentReceipts`) already: extracts
  RF codes from a receipt PDF via pdfjs, matches to `status:'pending'` Bills by RF, returns
  `{billId, buildingName, expenseName, totalAmount, term}` per match.
- `POST /bills/confirm-payment` (`confirmPayment`) already: sets matched Bills
  `status:'paid'`, `paymentDate`, `paymentProofUrl`; accepts an array (bulk).
- Bill schema already has `paymentProofUrl`, `paymentDate`, `status`.

### What Slice 6 ADDS
1. **Accept images** on the receipt path too (reuse Slice 1's `uploadBill` + `ocrImage`)
   — receipts arrive as phone photos/CamScanner, not just digital PDFs.
2. **OCR the receipt** and extract match keys BEYOND rfCode (verified against the real
   invoice: names/addresses/amounts/dates OCR reliably; long digit strings need checks):
   - amount (`Πληρωτέο`/total), date, RF code (checksum-validated), ΑΦΜ, IBAN
     (mod-97-validated), supplier/customer name.
3. **Suggested match, not auto** — score each PENDING bill (no matched receipt yet) against
   the receipt's extracted keys: RF exact = strong; else amount±date proximity + name/ΑΦΜ
   overlap = soft rank. Present the ranked list with the top candidate PRE-SELECTED
   (soft-select), user confirms/changes. "Pending" = Bills `status:'pending'` (utility) AND
   — once Slice 2 lands — any expense charge lacking a linked receipt.
4. **Installments / multi-record** — one receipt may partially pay a bill, or one bill may
   need N receipts. Keep EACH receipt as its own record linked to the bill; the bill is
   "fully paid" only when Σ(receipts) ≥ totalAmount. New `receipts[]` subdoc on Bill (or a
   Receipt collection) with `{amount, date, proofUrl, ocrText}` — NOT a single
   `paymentProofUrl` overwrite (the current single-field can't hold installments).
5. **Archive together in B2** (depends on Slice 5): store the bill source + each receipt
   under a shared key prefix so they move/live together.

### Core design: store ALL elements per bill, match receipt against them
(This is the user's architecture — do NOT classify receipt *type* by OCR, which is
unreliable. Instead: every imported bill persists its full extracted element set; an
incoming receipt's elements are scored against those stored sets; the closest match wins.)

**VERIFIED code facts this depends on:**
- Bill schema has **NO raw-text / element field** (`bill.ts` — checked). MUST ADD one.
- `ParsedBill` returns only 8 typed fields (`types.ts`) — **no ΑΦΜ / IBAN / name / raw
  text**. The parser MUST additionally emit the raw OCR text + a normalized element bag.
- **Only MATCHED bills get persisted** today (`BillImportDialog.js:170` `success && match`).
  Receipt-matching needs a record for EVERY imported bill → **Slice 6 DEPENDS ON Slice 2**
  (which persists unmatched bills via the create-expense flow). Without Slice 2 there is
  nothing to match a receipt against. Hard dependency, not optional.
- No fuzzy/scoring util exists in `services/` — new (small) code.

**Schema addition — `Bill.matchKeys` (new subdoc) + `Bill.ocrText` (String):**
```
matchKeys: {
  rfCodes: [String],        // all RF tokens found, checksum-validated
  ibans:   [String],        // all IBANs found, mod-97-validated
  amounts: [Number],        // all money figures (totalAmount + line totals)
  afm:     [String],        // any ΑΦΜ / VAT numbers
  dates:   [Date],          // issue/due/period + any date tokens
  nameTokens: [String]      // normalized supplier/customer name words
}
ocrText: String             // full raw OCR (the fallback bag for anything unstructured)
```
Populated at bill-confirm from the parse output (parser extended to emit these, not just
the 8 fields). This is "keep a record with all possible elements you found for each bill."

### Match-scoring (deterministic, no ML — "suggest", closest match)
When a receipt is OCR'd, extract the SAME element kinds, then score it against every
candidate bill's `matchKeys`:
```
score(bill, receipt):
  +100  rfCode ∈ bill.rfCodes        (checksum-valid — near-certain match)
  + 60  any receipt.amount ≈ any bill.amount   (|Δ| < 0.01)
  + 40  any receipt.iban ∈ bill.ibans          (checksum-valid)
  + 25  receipt.date within [issueDate, dueDate + 10d]
  + 20  receipt.afm ∈ bill.afm
  + 15  nameToken overlap (Jaccard on normalized words)
  → rank desc; pre-select top; show WHICH keys matched (not a fake %).
```
"Closest match" = highest score. RF or IBAN hit → confident; amount+date+name only →
soft suggestion the user confirms. Candidate set = bills with unpaid/partial balance.

**PRINCIPLE — every receipt matches on a DIFFERENT subset of elements; never require any
specific field.** This is why it's additive scoring, not rule-matching. A utility receipt
may carry an RF; a bank-transfer confirmation carries no RF but an IBAN + amount + invoice
ref; a POS slip may have only amount + date. The scorer sums whatever overlaps and ranks —
it must NEVER hard-require RF (or any single key), or whole classes of receipt score zero.
Because receipts are often OCR'd (noisy), elements may be partial/corrupt — so:
- score on the OCR'd elements that survived + checksum-validate RF/IBAN before trusting them
  as strong keys (a checksum-failed IBAN scores 0 on the IBAN dimension, not a false +40);
- a bill with more stored elements gives more surfaces to match — that's why §3 says each
  parser should extract as MANY elements as it reliably can (feeds both match paths).

**WORKED EXAMPLE (real, verified this session — bank-transfer receipt ↔ τιμολόγιο):**
A ΕΘΝΙΚΗ ΤΡΑΠΕΖΑ transfer confirmation (digital PDF, clean text layer — no OCR needed)
paid a Τιμολόγιο Πώλησης. It carries NO RF code, yet matches the invoice on THREE
independent keys — proving the subset-scoring design:
| Element | Τιμολόγιο (bill) | Απόδειξη (receipt) | dim |
|---|---|---|---|
| amount | 749,99 € | 749,99 € | +60 |
| payee IBAN | GR3301109999990000000000001 | to-IBAN GR3301109999990000000000001 | +40 (mod-97 VALID) |
| invoice # | 391 | «Τιμ Πωλ 391» | +20 |
| supplier name | DOKIMAMBOUS | DOKIMAMPOUS KOSTAS MARIOS | +15 (variant) |
→ confident top suggestion, RF never involved. A DIFFERENT receipt would score via a
different subset (e.g. RF+amount, or amount+date only) — the ranker handles both.
Note the payee IBAN here is the SAME one that passed mod-97 earlier while two others failed
— checksum picks the trustworthy key out of noisy OCR.

### UI (needs its own mock approval — steering Rule 6; must NOT be AI slop)
- A two-pane confirm panel: LEFT = the OCR'd receipt's recognized fields (editable,
  invalid IBAN/RF flagged); RIGHT = ranked list of pending bills with the suggested match
  pre-selected + why (matched-on-RF / matched-on-amount+date). Confirm links them, sets
  paid/partial, archives. **U6 — mock before code.** Follow DESIGN.md (no card grids, no
  nested cards, `1.234,56 €`, tabular mono money, sea-accent ≤5%).

### IBAN/RF fidelity — two-tier enhance (BOTH measured this session)

Long digit strings (IBAN, RF, ΜΑΡΚ) are where OCR drops/merges digits, because on a
full-page scan the detector shrinks the whole image to `maxSideLength` (960px) → an IBAN
line is ~10px tall → the recognizer drops a digit. MEASURED on the real invoice: 2 of 3
IBANs came out 26-digit (GR needs 27), and one that LOOKED exact to the eye failed mod-97.

**Checksum first (the safety net):** validate every extracted IBAN (ISO 13616 mod-97) + RF
(ISO 11649 mod-97). Never save unchecked. This deterministically flags the corrupt ones —
it caught all 3 bad cases above, including the one I misjudged by eye.

**Tier 1 — automatic re-crop retry (no user action, MEASURED to work):** when a field
fails its checksum, re-OCR ONLY that field's detected bounding box from the ORIGINAL
full-res upload, isolated (fills the frame → many more px/digit), then re-validate.
TESTED: cropping the IBAN band out of the same image and re-OCRing it recovered BOTH
broken IBANs → 1/3-valid became **3/3-valid, all checksum-confirmed**, with zero user
involvement. Note: plain interpolated upscale of the FULL page did NOT help (control) —
it's the ISOLATION (real px-per-digit after cropping), not upscaling, that works.

**Tier 2 — "Θα στείλω άλλη φωτογραφία": synchronized re-capture over the Telegram bot.**
When Tier 1 still fails the checksum, the OPEN dialog offers a button
**«Θα στείλω άλλη φωτογραφία»** (+ the field also stays editable as a manual fallback).
The bot is the camera; the desktop dialog synchronizes over it by polling:

1. User clicks the button → dialog enters a WAITING state (spinner + "Στείλτε τη
   φωτογραφία στο @MicroRealEstateBot…"). Server records the CURRENT Telegram
   `getUpdates` offset for this realm's admin chat as the correlation anchor.
2. User opens Telegram, snaps a zoomed close-up of just the failed line, sends to the bot.
3. The Telegram poller (Slice 4 — this Tier depends on it) sees the NEXT photo from the
   admin chat AFTER the recorded offset → that IS the retry (offset-correlated, no guessing
   which photo).
4. Server OCRs only that new image, extracts the target field(s), re-validates the checksum.
5. Dialog is polling a retry endpoint (`GET /inbox/:id/retry-capture?since=<offset>`); on
   success it updates the flagged field live (red → green) and leaves the waiting state.
6. TIMEOUT: if no photo arrives within ~2 min, the waiting state ends with "Δεν ελήφθη
   φωτογραφία — δοκιμάστε ξανά ή διορθώστε χειροκίνητα" and the field stays editable.

Correctness anchors: correlation = offset-at-click (the next admin-chat photo, not any
photo); the field is ALWAYS manually editable so the flow never dead-ends if the bot photo
also fails; DEPENDS on the Slice-4 poller + single-realm adminChatId mapping.
Tier 1 (server-side auto re-crop) still handles the common case invisibly with no user action.

Direct file upload (sharper) > Telegram-recompressed also helps at the source.

---

## 12. Fine-tuning (req #12) — honest answer

PP-OCR ONNX models are inference-only. Fine-tuning requires PaddlePaddle training framework + labeled data + GPU. Not a runtime feature.

**Practical substitute:** log every amendment `{provider, field, ocrValue, correctedValue}`. Three uses:
1. Per-provider correction map (deterministic string fixes applied before showing user).
2. Confidence gating: highlight fields with low confidence for mandatory eyeball.
3. If ≥100 corrections accumulate for a field type, that's the training dataset for offline fine-tuning later.

---

## 13. Resolved decisions (from code)

1. **Provider→type map** — matches the `BuildingExpenseSchema.type` enum (`building.ts:96`):
   - DEH → `electricity_common`
   - ΕΥΔΑΠ / ΔΕΥΑ → `water_common`
   - ΕΠΑ → `heating`
2. **`chargeOwnerWhenVacant` pre-fill** — `true` for utility types (electricity, water, heating). Schema default is `false` (`building.ts:143`), but a vacant unit's common utilities logically route to the owner. The toggle is visible in the confirm dialog — user overrides if wrong.
3. **Past/frozen term** — **warn-and-allow.** `saveMonthlyStatement` accepts any term 2020–2099 (`buildingmanager.ts:2916`); the engine already preserves frozen+occupied tenant charges internally (`buildingmanager.ts:4643-4652`). The assertion shows "Εκπρόθεσμο" but does not block confirm.
4. **Realm routing** — single-realm. One bot token, one `ADMIN_CHAT_ID` in `.secrets/`. Poller maps `message.chat.id === adminChatId` → that realm. No multi-realm problem exists.

## 14. Remaining blocker — ✅ MOSTLY RESOLVED 2026-07-26, see §17

~~Sample bills needed for providers #2 and #3 (ΕΥΔΑΠ Αττικής + ΕΠΑ)~~ — **the user supplied a
14-page PDF of real scanned bills + bank receipts on 2026-07-26.** ΕΥΔΑΠ is IN it (page 9,
fully OCR'd). This section stayed stale for five days and was repeatedly quoted back at the
user as "blocked on samples". Only **ΕΠΑ (gas)** is still absent — and it is now the *lowest*
priority, because NOVA (present, 3 bills) was never in the plan at all. See §17.

---

## 16. STATE OF PLAY — shipped slices + the 2026-07 post-ship audit

### 16.1 What is shipped (merged to `nas`)

Slices 1–6 are all in. Commit trail (`git log --grep`):

| Slice | Commits |
|---|---|
| 1 — image import + in-process OCR | `36a29f01`, `b540b7cd` (ExpenseFormDialog extract) |
| 2 — no-match confirm + charge bridge | `75e8f9b1` (2d), `1fd3b33d` (2e bridge), `b24ac171` (2f scanned-PDF via pdfium) |
| — review rounds on 1–2 | `7b7ee745`, `fcc62a0e`, `49d302d9` |
| 4 — Telegram inbox + bell | `9dffa425` |
| 5 — B2 archival | `86f78f4f` |
| 6 — απόδειξη matching | `f826d929`, `2a63d744` (Tier-2 re-capture), `fc2caebc` (αριθμός-παροχής pre-fill) |
| post-ship reviews | `2963e86f` (5 HIGH adversarial), `47f11072` (20 write-through-integrity bugs), `24033841` (resilience) |

**Slice 3 (providers) is NOT shipped** and is still blocked on §14 — no ΕΥΔΑΠ Αττικής or
ΕΠΑ sample bills. This is the only planned slice with no code.

### 16.2 The 2026-07 audit — 7 fixes, IN THE WORKING TREE, NOT YET COMMITTED

An audit of the *shipped* Slice 4–6 code found and fixed 7 defects. All are code-complete
with tests; none are committed, none are deployed. 18 modified files + 3 new
(`billidentity.ts`, `billidentity.test.js`, `renameBackfill.test.js`).

| # | Finding | Fix | Proof |
|---|---|---|---|
| 1 | 7 raw `toLocaleDateString`/`toLocaleString` calls | → `moment().format('L')` | build + locale read |
| 2 | `BuildingDashboard.js` dot-decimal euro + hardcoded `'months'` plural | i18n'd | build |
| 3 | **MED RECEIPT-IDENTITY** — receipt dedup keyed on `date`, which `mkReceipt` DEFAULTS to the server clock. Any retry (not just one crossing midnight) got a fresh stamp → same απόδειξη recorded twice → Σ(receipts) double-counted → bill silently flipped to `'paid'`. | identity = `proofUrl`, else `ocrText`; never a server-defaultable field | `confirmPayment.test.js`, mutation-verified |
| 4 | **LOW BATCH-TRUTH** — toast reported client *intent*, not server truth; failure path skipped cache invalidation | report from the server response; invalidate on both paths | tests + 6 locales |
| 5 | **MED BILL-IDENTITY** — bill dedup keyed on fields the server could default | key only on OCR-derived `term`; proximity (±10d on `periodEnd`), NOT interval overlap, discriminates physical-bill identity | new `billidentity.ts` + 15 tests |
| 6 | **LOW RENAME-BACKFILL** — a description-keyed identity went stale on rename | stamp `expenseId` at rename time, while the OLD name still exists | 16 tests, 3 mutants killed |
| 7 | **LOW OVERPAY-CREDIT** — see 16.3 | derived `overpaid` + operator warning | 10 tests, 4 mutants killed |

Plus one test-harness repair: `mediumBatch.test.js`'s `@microrealestate/common` mock
spread `...real`, so it carried the REAL `Service` singleton. A later commit added a
`Service.getInstance()` call to an exercised path and the suite broke — a *pre-existing*
gap that blocked the green gate and had nothing to do with these fixes.

### 16.3 Why OVERPAY-CREDIT is worth reading (the generalisable lesson)

Σ(receipts) exceeding what is owed had **no representation anywhere** — this was an
*absent* representation, not a wrong number, which is why no surface was "wrong":

- `bill.status` enum is exactly `['pending','partial','paid']` (`bill.ts:32-38`) — no overpay value.
- the dashboard clamps: `Math.max(0, total - paidSoFar)` (`dashboardmanager.ts:974`).
- **both** the dashboard tile query (`dashboardmanager.ts:929`) and the receipt-candidate
  query (`billmanager.ts:1143`) filter `status: {$in:['pending','partial']}` — so an
  overpaid bill (now `'paid'`) *vanishes from both*.

So a receipt matched to the WRONG bill, or an amount typed with a slipped decimal, looked
like a clean payment. Design constraints that fell out of that:

1. **Derive, never persist.** Persisting the excess adds a second source of truth for the
   same arithmetic.
2. **Never add a `status` value.** A 4th value silently excludes the bill from four
   existing `status:{$in:[...]}` queries (`dashboardmanager.ts:929`, `billmanager.ts:1143`,
   `billmanager.ts:1371`, `buildingmanager.ts:4685`).
3. **Report at the only moment it matters.** `confirmPayment` both creates the excess and
   is the only moment the operator is still looking at the receipt they matched.
4. **Flag, don't refuse.** Dropping money the landlord actually paid is worse than
   recording it visibly and flagging it (same rule the dedup guard already documents).
5. **The tolerance is DIRECTIONAL.** The `+0.005` used for the paid/partial decision exists
   for the SHORTFALL direction (99,995 must count as 100,00). Reused in the EXCESS
   direction it fires on `33,34+33,34+33,33 = 100,01` — the ordinary artifact of splitting
   an odd total across installments. Threshold is one cent. *My first implementation copied
   the half-cent and my own new test caught it; I fixed the code, not the test.*

### 16.4 Where the design was WRONG and what replaced it

Recorded because the plan should not read as if it were right the first time:

- **RENAME-BACKFILL's designed call site was BROKEN.** The design named
  `1_base.ts:1095-1130`. That is the rent-computation pipeline — it does not see rename
  events and cannot stamp identity at rename time. Actually fixed at the
  description-keyed backfill in `buildingmanager.ts:3016-3035` plus the strip at
  `:3054-3061`, i.e. where the rename actually happens *while the old name still exists*.
- **Money surfaces were missing from the original plan's requirements (§0).** They are
  first-class prerequisites, not downstream consumers: any change to bill/receipt state
  must be checked against `MONEY_SURFACE_MATRIX.md` *and* against every
  `status:{$in:[...]}` query before it is called complete.
- **Source-derived identity is a requirement, not an implementation detail.** An
  idempotency key must contain only fields the SOURCE DOCUMENT carries. Three of the seven
  fixes (3, 5, 6) are the same bug in three places.

### 16.5 OWED — not done, and not claimable as done

1. **Greek-screen UI review** for the five touched surfaces — `BillImportDialog`,
   `InboxBell`, `PaymentReceiptDialog` (including the NEW overpay warning toast),
   `BuildingDashboard` projection row, `settings/database`. **Currently impossible: NAS is
   unreachable** (`landlord signin: 000`, `portainer: 000`). Per
   `ui-review-do-not-skip.md` this work is NOT done until those screens are screenshotted
   in `/landlord/el/...` and read.
2. **Playwright on live NAS** — same blocker. No spec for the overpay path has run against
   real data, so per `E2E_TESTING.md` it does not count as coverage yet.
3. **Deploy — NOT AUTHORIZED.** Nothing in this batch has been pushed or deployed.

### 16.6 Verified gates (run 2026-07-31, local)

- `npx tsc --noEmit -p tsconfig.json` in `services/api` → **EXIT=0**
- full api jest under node@20 → **875 passed / 17 skipped / 892 total, 54 suites passed
  + 1 skipped, 0 failed** (13.2s)
- `yarn workspace @microrealestate/landlord build` → **EXIT=0**, full route table emitted
- four touched suites together (`confirmPayment billidentity renameBackfill mediumBatch`)
  → 4 suites / 60 tests passed
- mutation-tested: RECEIPT-IDENTITY, RENAME-BACKFILL (3 mutants), OVERPAY (4 mutants —
  each killing exactly its intended subset, which is what proves the guards aren't
  vacuously green)

---

## 17. Slice 3 — the samples were never missing (correcting a 5-day-old false blocker)

### 17.1 What actually happened

**§14 said "blocked on sample bills" for five days while the samples sat on disk.** The user
supplied them on **2026-07-26** and they were OCR'd the same day, by this project's own
pipeline, with **zero errors on all 14 pages**. Every subsequent session — including the
2026-07-31 audit write-up — re-quoted the stale blocker back at the user instead of reading
its own scratch directory. The correct move, before writing "blocked" anywhere: `find . -iname '*.pdf'`.

Artifacts — **moved OUT of the repo tree on 2026-08-01** to
`~/mre-pii-backup-2026-08-01/real-bill-samples/bill-samples/`. They are scans of a
live utility account: names, ΑΦΜ, παροχή numbers, RF codes, a payee IBAN. They were
sitting in a gitignored directory inside a public repo's working tree, which is one
`git add -A -f` away from publication — that is exactly how the 2026-08-01 leak
happened. Do not move them back in. Paths below are relative to that directory:

| Path | What |
|---|---|
| `logariasmoi.pdf` | 6.9 MB, **14 pages**, PDF 1.7, CamScanner scans |
| `ocr-out/page-NN.txt` | per-page ground-truth OCR (14 files) |
| `ocr-out/ALL_PAGES.txt` | all pages concatenated (25 KB) |
| `ocr-out/summary.json` + `summary-tail.json` | chars/lines/secs per page, **`err: null` on every page** |
| `ocr_all.mjs` | the driver — imports the REAL `rasterizePdfToImages` + `ocrImage` from `dist/`, i.e. exactly the bill-import path |

OCR cost: 2.2 s (sparse receipt) → 17.0 s (dense ΕΥΔΑΠ bill), ~95 s for all 14 pages.

### 17.2 Sample inventory — 7 bill+receipt pairs, verified by marker grep

| Page | Document | `detectProvider()` today |
|---|---|---|
| 1 | **NOVA** telecoms bill — 27,38 € + 6,60 € prior = 33,98 € | **`null`** → "Δεν αναγνωρίστηκε ο πάροχος" |
| 2 | Alpha Bank receipt — NOVA, 33,98 € | (receipt) |
| 3 | **ΔΕΗ** bill — 120,00 €, RF code present (synthetic stand-in: `RF33999000000000000000001`) | `deh` ✅ parses |
| 4 | Alpha Bank receipt — ΔΕΗ, 120,00 € | (receipt) |
| 5 | **ΔΕΗ** bill | `deh` ✅ |
| 6 | Piraeus receipt — ΔΕΗ, 4/6/2026 | (receipt) |
| 7 | **NOVA** bill | **`null`** |
| 8 | Alpha Bank receipt — NOVA, 21,03 € | (receipt) |
| 9 | **ΕΥΔΑΠ** bill — 72,11 €, the "missing" sample | `eydap` → **"δεν υποστηρίζεται ακόμα"** |
| 10 | CrediaBank receipt — ΕΥΔΑΠ | (receipt) |
| 11 | **NOVA** bill | **`null`** |
| 12 | CrediaBank receipt — NOVA/ex-WIND, RF | (receipt) |
| 13 | **ΔΕΗ** bill | `deh` ✅ |
| 14 | CrediaBank receipt — ΔΕΗ 90773, RF | (receipt) |

Grep-verified: `ΕΥΔΑΠ|eydap\.gr` matches **only page 9 (5×) and 10 (1×)**; `ΔΕΗ|dei\.gr` matches
pages 3,4,5,6,13,14; **no page contains `ΕΠΑ|ΔΕΠΑ|Φυσικ|Αέρι|ΑΕΡΙΟ`.**

### 17.3 Two corrections to the plan's own premises

1. **ΕΠΑ is NOT the priority — NOVA is, and NOVA is not in this document.** The user's real bills
   are ΔΕΗ ×3, NOVA ×3, ΕΥΔΑΠ ×1. The plan named ΕΥΔΑΠ/ΕΠΑ/ΔΕΥΑ-Τήνου and never mentioned
   telecoms, so **3 of 7 sample bills fall through `detectProvider` to `null`** and produce
   "Δεν αναγνωρίστηκε ο πάροχος" — the plan optimised for a provider that isn't in the data
   while ignoring one that is 43% of it.
2. **NOVA has no `type` to map to.** `BuildingExpenseSchema.type` (`building.ts:92-108`) is
   `heating|elevator|cleaning|water_common|electricity_common|insurance|management_fee|garden|repairs_fund|pest_control|other`
   — there is **no telecoms/internet value**. §13's provider→type map has no answer for NOVA;
   it would land in `other`. Whether a landlord's telecoms bill is even a *building* expense
   (vs. a personal one that shouldn't enter this flow at all) is a **product question for the
   user**, not a parser question. Do not invent an enum value — see the absent-representation
   rule in `MONEY_SURFACE_MATRIX.md`.

Also stale: §3's proposed `providers/` tree lists `deuaTinou/` "← the bill we tested". There is
**no `providers/` directory at all** (`billparser/` holds only `deh.ts`, `index.ts`,
`matching.ts`, `ocr.ts`, `types.ts`), and no ΔΕΥΑ Τήνου sample among these 14 pages.

### 17.4 ΕΥΔΑΠ ground truth — every field a parser needs (`ocr-out/page-09.txt`)

| Field | Value | Line(s) | Note |
|---|---|---|---|
| Amount payable | `72,11` | 40, 89 (`ΜΕΡΙΚΟ ΣΥΝΟΛΟ`), 91 (`ΠΛΗΡΩΤΕΟ`), 117 (`72,11€`) | 4 independent occurrences → cross-checkable |
| Due date | `05/06/2026` | 39, 116 | `ΛΗΞΗ ΠΡΟΘΕΣΜΙΑΣ ΠΛΗΡΩΜΗΣ` |
| Issue date | `07/05/2026` | 34, 107 | |
| Consumption period | `29/01/2026-27/04/2026` | 41, 98 | **a 3-month period — see 17.5** |
| Document no. | `2026 0009 9990 0000 01` | 42, 115 | spaced quartets |
| Registry no. (ΑΡ. ΜΗΤΡΩΟΥ) | `9990001-33` | 17, 102 | the stable per-meter id |
| Consumption | `53` m³ | 29, 104 | |
| Payment barcode line | `20260009999000000000072112026060509990001` | 96 | concatenates doc-no(16) + amount(9) + due-date(8) + registry(8) |

> **Identifiers in this section are SYNTHETIC**, rewritten to the exact shape and
> length of the real ones (so a parser written against this table works on a real
> bill) but carrying reserved `999…` values. The real document numbers, registry
> numbers, RF codes and barcode lines are personal data tied to a live utility
> account; they belong in `.scratch-adv-tests/` (gitignored), never here. This
> repo is public.

**No `RF` code on the ΕΥΔΑΠ bill** — unlike ΔΕΗ (`RF33999000000000000000001`, page 3 line 22)
and NOVA (`RF06 9990 0000 0000 0000 0000 2`, page 1). ΕΥΔΑΠ identity must come from
`ΑΡΙΘΜΟΣ ΜΗΤΡΩΟΥ` + `ΑΡΙΘΜΟΣ ΠΑΡΑΣΤΑΤΙΚΟΥ`. Any code assuming "a bill has an RF" — including
`generateIrisQr` (`index.ts:104-123`, returns `null` without one) and the Slice-6 Tier-2
RF-recapture path — must degrade gracefully, not treat ΕΥΔΑΠ as a failed parse.

The line-break trap the plan already documents (§3) is **confirmed on real ΕΥΔΑΠ text and is
worse than described**: this is a *columnar* bill, so ALL labels come first (lines 4-11:
`ΑΡΙΘΜΟΣ ΛΟΓΑΡΙΑΣΜΟΥ`, `ΤΙΜΟΛ.`, `ΕΙΔ. ΚΑΤ.`, `ΑΡΙΘΜΟΣ ΜΕΤΡΗΤΗ`, `ΑΡΙΟΜΟΣ ΜΗΤΡΩΟΥ`, `Α.Φ.Μ.`)
and then ALL values (lines 13-17). A label is 4-8 lines from its value, and `[\s\S]*?` from
label to "first number" grabs the WRONG column. **ΕΥΔΑΠ needs positional/ordinal column
pairing, not label-proximity regex.** Note also OCR corruption in the labels themselves —
`ΑΡΙΟΜΟΣ` for `ΑΡΙΘΜΟΣ` (line 10), `ΑΡΙΘΜΟΣ ΜΗΤΡΩΟΥ` intact at 101 — so label regexes must
tolerate Θ↔Ο confusion or anchor on the intact copy in the stub.

### 17.5 Money-correctness risks specific to ΕΥΔΑΠ (read before writing the parser)

1. **A 3-month consumption period vs. a monthly charge model.** `29/01/2026-27/04/2026` spans
   three terms. Every other provider here is monthly. Which `term` does a quarterly water bill
   post to — issue month, due month, or split across three? This decides whether the amount is
   allocated once or thrice, so it is a **money decision requiring the user's answer**, not a
   parser default. It also interacts with the ±10-day `periodEnd` proximity rule in
   `billidentity.ts` (§16.2 fix 5), which was designed against monthly bills.
2. **`ΠΡΟΗΓΟΥΜΕΝΕΣ ΟΦΕΙΛΕΣ` (previous debts), line 65.** NOVA has the same trap explicitly:
   page 1 shows `Σύνολο παρόντος λογαριασμού 27,38 €` but `Συνολικό ποσό πληρωμής 33,98 €`
   (= 27,38 + 6,60 prior balance) — and **the bank receipt on page 2 is for 33,98 €.** So the
   receipt legitimately exceeds the current bill. A parser that takes the largest euro figure
   as "the bill amount" **double-counts the prior balance** (it was already a charge in an
   earlier term). This is exactly the shape the new OVERPAY warning (§16.3) would fire on —
   correctly. Parse **current-period** amount for the charge; keep total-payable separately for
   receipt matching.
3. **`ΠΙΣΤΩΤΙΚΟ` (credit), line 79** — a credit column exists on ΕΥΔΑΠ. Confirm it is empty
   here before assuming amounts are always positive.

### 17.6 What Slice 3 actually needs (nothing is blocked)

Ready to build now, no new inputs required:

1. **ΕΥΔΑΠ parser** — real ground truth in hand; **column-pair extraction, not label regex**;
   no-RF path; decide current-period vs total-payable per 17.5.2.
2. **NOVA parser + `detectProvider` marker** (`/NOVA/i`, `/nova\.gr/i`) — 3 of 7 sample bills.
   Has an RF code, so it fits the existing QR/matching machinery. **Blocked only on the
   product question in 17.3.2** (which expense `type`, or whether telecoms belongs here).
3. **Fixture-backed jest suites** — copy the page texts into
   `services/api/src/__tests__/fixtures/` so the suites don't depend on the untracked scratch
   dir. (`billparser.test.js` has 34 tests; its only ΕΥΔΑΠ coverage is a `detectProvider`
   assertion on a 3-line synthetic string, line 254 — no real-text parse test exists.)
4. **7 bank-receipt fixtures for Slice 6** — Alpha ×3, Piraeus ×1, CrediaBank ×3, each pairing
   with a known bill. This is *free* end-to-end matching test data that is currently unused.
5. **Decide `providers/` tree or not** — §3's versioned structure was never built. `deh.ts`
   works fine flat; adding two more parsers is the moment to decide, and the answer may be
   "keep it flat, delete §3's tree."

**Genuinely still missing: an ΕΠΑ (gas) sample.** Not in these 14 pages. Lowest priority of
everything above — and per `.kiro/steering/`, no ΕΠΑ parser gets written from invented regexes.

**Not startable until NAS returns:** the E2E gate + Greek-screen review for any of it.
