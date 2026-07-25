import {
  Collections,
  logger,
  ServiceError,
  Service
} from '@microrealestate/common';
import type { ServiceRequest, ServiceResponse } from '@microrealestate/types';
import {
  parseBillPdf,
  generateIrisQr,
  normalizeBillingId
} from './billparser/index.js';
import * as billStorage from './billstorage.js';
import {
  computeIdf,
  extractElements,
  repairMatchKeys,
  scoreTokens,
  type BillElements
} from './billparser/matching.js';
import { validateObjectId } from '../validators.js';
import axios from 'axios';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = ServiceRequest<any, any, any>;
type Res = ServiceResponse;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeDefaultTerm(periodEnd: Date): number {
  const year = periodEnd.getUTCFullYear();
  const month = periodEnd.getUTCMonth() + 1;
  return year * 1000000 + month * 10000 + 100;
}

/**
 * Bridge a confirmed bill's amount into the tenant-charge engine by calling the
 * existing saveMonthlyStatement route (which owns all allocation / owner /
 * vacant logic). CRITICAL (C6/C7): saveMonthlyStatement STRIPS every
 * monthlyCharge for the term and rebuilds from the entries passed — so we MUST
 * resend ALL existing expense entries for the term, not just the bill's, or the
 * month's other charges are silently wiped. We reuse the route (not the 400-line
 * handler as a function) via an internal self-call with a minted service token,
 * exactly as leaseExpiryScanner does for the emailer.
 */
// PURE + EXPORTED for unit testing (C6/C7 no-clobber guard). Gathers the FULL
// set of expense entries for `term` from the building's persisted
// monthlyCharges (grouped by expenseId, reading inputAmount — the landlord-typed
// full figure preserved across recompute), then merges the new bill's expense.
// saveMonthlyStatement STRIPS all term charges and rebuilds from what we pass,
// so the returned set MUST contain every sibling or they are silently wiped.
export function buildStatementEntries(
  building: any,
  expenseId: string,
  amount: number,
  description: string,
  term: number
): { expenseId: string; amount: number; description: string }[] {
  // H1: monthlyCharges also carry REPAIR charges (repairId set, expenseId=null —
  // building schema defaults expenseId to null). Those must NOT be echoed as
  // expense entries: String(null)==='null' would send {expenseId:'null'} and
  // saveMonthlyStatement 422s "Unknown expenseId". saveMonthlyStatement owns only
  // source:'expense' rows; repair rows are rebuilt by their own recompute. Skip them.
  const byExpense = new Map<
    string,
    { inputAmount: number | null; shareSum: number; description: string }
  >();
  for (const unit of building.units || []) {
    for (const c of unit.monthlyCharges || []) {
      if (Number(c.term) !== Number(term)) continue;
      if (!c.expenseId || (c as any).repairId) continue; // skip repair/null rows
      const eid = String(c.expenseId);
      const prev = byExpense.get(eid);
      if (prev) {
        // M1: accumulate per-unit shares so a legacy row with no inputAmount can
        // reconstruct the FULL figure by summing shares across units — never fall
        // back to a single unit's per-unit slice (that halves the statement).
        prev.shareSum += Number(c.amount) || 0;
        if (prev.inputAmount == null && c.inputAmount != null) {
          prev.inputAmount = Number(c.inputAmount);
        }
      } else {
        byExpense.set(eid, {
          inputAmount: c.inputAmount != null ? Number(c.inputAmount) : null,
          shareSum: Number(c.amount) || 0,
          description: c.description || ''
        });
      }
    }
  }
  const entries = [...byExpense.entries()].map(([eid, v]) => ({
    expenseId: eid,
    // Prefer the landlord-typed full figure (inputAmount); else the sum of
    // per-unit shares reconstitutes the full statement amount for legacy rows.
    amount: v.inputAmount != null ? v.inputAmount : v.shareSum,
    description: v.description
  }));
  // Merge (add or replace) the bill's expense at its full amount.
  const billIdx = entries.findIndex((e) => e.expenseId === String(expenseId));
  if (billIdx >= 0) {
    entries[billIdx] = { expenseId: String(expenseId), amount, description };
  } else {
    entries.push({ expenseId: String(expenseId), amount, description });
  }
  return entries;
}

async function bridgeChargeToStatement(
  realmId: string,
  buildingId: string,
  expenseId: string,
  term: number,
  amount: number,
  description: string
): Promise<void> {
  const building: any = await Collections.Building.findOne({
    _id: buildingId,
    realmId
  }).lean();
  if (!building) {
    throw new ServiceError(`Building ${buildingId} not found`, 404);
  }

  const expenses = buildStatementEntries(
    building,
    expenseId,
    amount,
    description,
    term
  );

  // Internal self-call to the monthly-statement route. api serves its routes
  // under the /api/v2 base (the gateway target API_URL is http://api:8200/api/v2),
  // so a bare /buildings/... 404s — verified. Hit our own port under /api/v2.
  // NOTE: the '/api/v2' base below is a literal that must track the router mount
  // (routes.ts). If the mount prefix ever changes, this self-call must change too;
  // a shared API_SELF_BASE config would remove the coupling (future cleanup).
  const { PORT } = Service.getInstance().envConfig.getValues() as any;
  const port = PORT || process.env.PORT || 8200;
  const token = await Service.getInstance().createServiceToken(
    'administrator',
    realmId
  );
  await axios.post(
    `http://localhost:${port}/api/v2/buildings/${buildingId}/monthly-statement`,
    { term, expenses },
    {
      headers: {
        authorization: `Bearer ${token}`,
        organizationid: realmId
      },
      timeout: 30_000
    }
  );
}

async function findExpenseByBillingId(
  realmId: string,
  normalizedBillingId: string
): Promise<{
  building: any;
  expense: any;
} | null> {
  const buildings = await Collections.Building.find({ realmId }).lean();

  // Compute the current YYYYMMDDHH term — soft-deleted expenses carry
  // endTerm < current and must be skipped so a freshly imported bill does
  // not auto-link to a retired expense.
  const now = new Date();
  const currentTerm = Number(
    `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}0100`
  );

  for (const building of buildings) {
    for (const expense of building.expenses || []) {
      if (!expense.billingId) continue;
      // Skip soft-deleted (endTerm < current) expenses.
      if (expense.endTerm && Number(expense.endTerm) < currentTerm) continue;
      const expenseNormalized = normalizeBillingId(expense.billingId);
      if (expenseNormalized === normalizedBillingId) {
        return { building, expense };
      }
    }
  }
  return null;
}

/**
 * Match a bill's αριθμός παροχής (billingId) to a specific UNIT by its stored
 * supply number (unit.electricitySupplyNumber, the ΔΕΗ παροχή populated from E9
 * / building import). When it hits we know the building AND the exact apartment
 * — so a "no existing δαπάνη" bill can pre-fill create-expense with the building
 * selected + single_unit allocation targeting that apartment. Compared on the
 * normalized digits so spacing/dashes don't matter.
 *
 * Returns null when no unit carries that supply number (common — many bills are
 * building-level, or the unit's number was never imported).
 */
async function findUnitBySupplyNumber(
  realmId: string,
  normalizedBillingId: string
): Promise<{
  buildingId: string;
  buildingName: string;
  propertyId: string;
  unitLabel: string;
} | null> {
  if (!normalizedBillingId) return null;
  const buildings = await Collections.Building.find({ realmId }).lean();
  for (const building of buildings as any[]) {
    for (const unit of building.units || []) {
      const supply = unit.electricitySupplyNumber;
      if (!supply) continue;
      if (normalizeBillingId(String(supply)) === normalizedBillingId) {
        return {
          buildingId: String(building._id),
          buildingName: building.name || '',
          propertyId: String(unit.propertyId || unit._id),
          unitLabel:
            unit.name || unit.unitLabel || unit.atakNumber || 'Διαμέρισμα'
        };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * POST /bills/parse
 * Accept multipart PDFs (field: "bills"), parse and return results
 * for user confirmation. Does NOT save anything.
 */
export async function parseBills(req: Req, res: Res): Promise<void> {
  const realmId = req.realm?._id;
  if (!realmId) {
    throw new ServiceError('Unauthorized', 401);
  }

  const files = (req as any).files as Express.Multer.File[];
  if (!files || files.length === 0) {
    throw new ServiceError('Δεν βρέθηκαν αρχεία PDF', 422);
  }

  // NOTE: the old "at least one expense in the realm has a billingId" precheck
  // was removed (§2.1b) — with the new "no match → create expense from OCR"
  // flow, a fresh building with zero billingIds must still be parseable.
  // findExpenseByBillingId returns null gracefully when nothing matches; the
  // UI handles that case instead of the parse being blocked up-front.
  const results = [];

  for (const file of files) {
    // Isolate per-file: a throw in parseBillPdf (OCR decode failure, pixel-bomb
    // reject, corrupt PDF) must fail ONLY this file, not 500 the whole batch —
    // the other files in the upload still parse and are shown to the user.
    let parseResult;
    try {
      parseResult = await parseBillPdf(file.buffer);
    } catch (err: any) {
      logger.error(
        `parseBillPdf threw for ${file.originalname}: ${err?.message || err}`
      );
      results.push({
        filename: file.originalname,
        success: false,
        error: err?.message || 'Αποτυχία ανάλυσης λογαριασμού'
      });
      continue;
    }

    if (!parseResult.success || !parseResult.bill) {
      results.push({
        filename: file.originalname,
        success: false,
        error: parseResult.error
      });
      continue;
    }

    const { bill } = parseResult;

    // Try to match billing ID to an expense
    const match = await findExpenseByBillingId(
      realmId,
      bill.billingIdNormalized
    );

    // No existing δαπάνη? Try to identify the BUILDING + APARTMENT by the
    // αριθμός παροχής (unit.electricitySupplyNumber) so the create-expense
    // pre-fill can select the building + target that single unit. Only computed
    // for the no-match case (a matched bill already knows its building/expense).
    const unitMatch = match
      ? null
      : await findUnitBySupplyNumber(realmId, bill.billingIdNormalized);

    // Generate IRIS QR from RF code + payment code (verified approach).
    // C2 fix: generate regardless of match — the QR is about the bill's
    // payment reference, not the expense match. For providers without a
    // paymentCode (e.g. ΔΕΥΑ Τήνου), generateIrisQr returns null gracefully.
    let irisCodeBase64: string | undefined;
    try {
      const qrBuffer = await generateIrisQr(bill.rfCode, bill.paymentCode);
      if (qrBuffer) {
        irisCodeBase64 = qrBuffer.toString('base64');
      }
    } catch (e) {
      logger.debug(`QR generation failed for ${file.originalname}: ${e}`);
    }

    // Check for existing bill in same term+expense
    let existingAmount: number | undefined;
    if (match) {
      const existing = await Collections.Bill.findOne({
        realmId,
        buildingId: String(match.building._id),
        expenseId: String(match.expense._id),
        term: computeDefaultTerm(bill.periodEnd)
      }).lean();
      if (existing) {
        existingAmount = (existing as any).totalAmount;
      }
    }

    // Slice 6 — persist the raw OCR text (capped) so an incoming απόδειξη can be
    // scored against this bill. ocrText is the SINGLE source of truth for the
    // receipt matcher: parsePaymentReceipts rebuilds the full soft-TF-IDF token
    // bag from it (via extractElements) at match time, folding in the bill's
    // structured strong keys. We do NOT persist a pre-built element bag — a
    // stored snapshot would be a lossy partial (no `tokens`) and go stale.
    results.push({
      filename: file.originalname,
      success: true,
      parsed: {
        provider: bill.provider,
        billingId: bill.billingId,
        billingIdNormalized: bill.billingIdNormalized,
        totalAmount: bill.totalAmount,
        periodStart: bill.periodStart,
        periodEnd: bill.periodEnd,
        issueDate: bill.issueDate,
        dueDate: bill.dueDate,
        rfCode: bill.rfCode,
        paymentCode: bill.paymentCode, // C1 fix: was omitted, confirm stores null
        irisCodeBase64,
        proposedTerm: computeDefaultTerm(bill.periodEnd),
        ocrText: (parseResult.rawText || '').slice(0, 4000)
      },
      match: match
        ? {
            buildingId: String(match.building._id),
            buildingName: match.building.name,
            expenseId: String(match.expense._id),
            expenseName: match.expense.name
          }
        : null,
      // Building + apartment identified by the αριθμός παροχής when there is no
      // existing δαπάνη — drives the create-expense pre-fill (building selected
      // + single_unit targeting this apartment). Null when nothing matched.
      unitMatch,
      existingAmount
    });
  }

  res.json(results);
}

/**
 * POST /bills/confirm
 * Save confirmed bills. Accepts irisCodeBase64 from the parse step and
 * stores it as a data URI. B2 upload can be layered in later.
 */
export async function confirmBills(req: Req, res: Res): Promise<void> {
  const realmId = req.realm?._id;
  if (!realmId) {
    throw new ServiceError('Unauthorized', 401);
  }
  // Slice 5: B2 archival context. When B2 is configured for the realm we
  // archive the IRIS QR PNG (and any source key already set) and store B2
  // keys instead of the inline data-URI blob. Not configured → inline stays.
  const realmName = String((req.realm as any)?.name || '');
  const b2Config = (req.realm as any)?.thirdParties?.b2;
  const b2On = billStorage.isEnabled(b2Config);

  const { bills } = req.body;
  if (!bills || !Array.isArray(bills) || bills.length === 0) {
    throw new ServiceError('Δεν βρέθηκαν λογαριασμοί για αποθήκευση', 422);
  }

  const saved = [];

  for (const billData of bills) {
    const {
      buildingId,
      expenseId,
      provider,
      billingId,
      totalAmount,
      periodStart,
      periodEnd,
      issueDate,
      dueDate,
      term,
      rfCode,
      paymentCode,
      irisCodeBase64,
      // B2 key of a source file already archived out-of-band (the Telegram
      // inbox path archives at ingest and passes the key here). Set directly
      // onto the Bill — no re-upload.
      sourcePdfUrl,
      // Slice 6 — the raw OCR text from the parse step, persisted so an incoming
      // απόδειξη can be scored against this bill (the matcher rebuilds the token
      // bag from ocrText at match time — see parsePaymentReceipts).
      ocrText,
      replaceExisting,
      chargeThisMonth,
      expenseName
    } = billData;

    // Per-bill isolation: the batch is NON-atomic by design (each bill is an
    // independent Bill doc + optional charge). A validation/save failure on one
    // bill (bad term, 409 duplicate, etc.) must NOT abort the batch and roll the
    // client into a blanket "Failed to save bills" — the bills that DID save are
    // committed. Capture the failure as an index-aligned entry and continue so
    // the client can report accurate partial success.
    try {
      // Verify building belongs to this realm
      const building = await Collections.Building.findOne({
        _id: buildingId,
        realmId
      }).lean();
      if (!building) {
        throw new ServiceError(`Το κτίριο ${buildingId} δεν βρέθηκε`, 404);
      }

      // Verify expense exists on this building
      const expenseExists = (building as any).expenses?.some(
        (e: any) => String(e._id) === expenseId
      );
      if (!expenseExists) {
        throw new ServiceError(
          `Η δαπάνη ${expenseId} δεν βρέθηκε στο κτίριο`,
          404
        );
      }

      // Validate term (YYYYMMDDHH) — it lands on the Bill doc AND, when charging,
      // is passed to the monthly-statement bridge. saveMonthlyStatement enforces
      // this same shape; validating here fails fast with a clear error instead of
      // a swallowed bridge 422 or a malformed term on the stored Bill.
      if (!term || !/^\d{10}$/.test(String(term))) {
        throw new ServiceError(
          `Invalid bill term (expected YYYYMMDDHH, got ${term})`,
          422
        );
      }
      // Match saveMonthlyStatement's range check (buildingmanager.ts:2920) — a
      // regex-valid but out-of-range term would otherwise pass here and only fail
      // later in the swallowed bridge self-call.
      if (Number(term) < 2020010100 || Number(term) > 2099123100) {
        throw new ServiceError(
          `Bill term out of valid range (got ${term})`,
          422
        );
      }

      // Reject zero or negative totalAmount. A bill that costs nothing is
      // never a real bill — it's almost always OCR / parser failure or a
      // stale draft. Persisting zero/negative pollutes downstream
      // dashboards and reconciliation. Allow a small tolerance for
      // floating-point dust.
      const _ta = Number(totalAmount);
      if (!Number.isFinite(_ta) || _ta <= 0.005) {
        throw new ServiceError(
          `Bill totalAmount must be a positive number (got ${totalAmount})`,
          422
        );
      }

      // Tier A6 (B3) — Bill date validation. periodStart and periodEnd are
      // required and must be valid dates with periodStart ≤ periodEnd.
      // issueDate / dueDate are optional but, when set, must be valid and
      // ordered (issueDate ≤ dueDate). Without these, a malformed
      // periodStart pollutes the rent ledger silently (becomes Invalid Date,
      // breaks getUTCFullYear()/getUTCMonth() in computeDefaultTerm, and
      // computes an out-of-range term that lands on the wrong month).
      if (!periodStart || !periodEnd) {
        throw new ServiceError(
          'Bill periodStart and periodEnd are required',
          422
        );
      }
      const _ps = new Date(periodStart);
      const _pe = new Date(periodEnd);
      if (Number.isNaN(_ps.getTime()) || Number.isNaN(_pe.getTime())) {
        throw new ServiceError(
          'Bill periodStart / periodEnd must be valid dates',
          422
        );
      }
      if (_ps.getTime() > _pe.getTime()) {
        throw new ServiceError(
          'Bill periodStart must be on or before periodEnd',
          422
        );
      }
      if (issueDate !== undefined && issueDate !== null && issueDate !== '') {
        const _id = new Date(issueDate);
        if (Number.isNaN(_id.getTime())) {
          throw new ServiceError('Bill issueDate must be a valid date', 422);
        }
        if (dueDate !== undefined && dueDate !== null && dueDate !== '') {
          const _dd = new Date(dueDate);
          if (Number.isNaN(_dd.getTime())) {
            throw new ServiceError('Bill dueDate must be a valid date', 422);
          }
          if (_id.getTime() > _dd.getTime()) {
            throw new ServiceError(
              'Bill issueDate must be on or before dueDate',
              422
            );
          }
        }
      }

      // provider + billingId are schema-required. Validate them BEFORE the
      // destructive replaceExisting delete below — otherwise a confirm missing
      // either field would delete the existing Bill and then throw a Mongoose
      // ValidationError on save (the catch only handles duplicate-key 11000 and
      // rethrows everything else), leaving the period with NO bill at all.
      const VALID_PROVIDERS = ['deh', 'eydap', 'epa', 'other'];
      if (!provider || !VALID_PROVIDERS.includes(String(provider))) {
        throw new ServiceError(
          `Bill provider must be one of ${VALID_PROVIDERS.join(', ')} (got ${provider})`,
          422
        );
      }
      if (!billingId || !String(billingId).trim()) {
        throw new ServiceError('Bill billingId is required', 422);
      }

      // If replacing, remove existing bill for same term+expense. Safe now that
      // the required fields above are validated — the subsequent save won't
      // throw a ValidationError after the delete.
      if (replaceExisting) {
        await Collections.Bill.deleteMany({
          realmId,
          buildingId,
          expenseId,
          term
        });
      }

      // Store IRIS QR inline as a data URI initially; if B2 is configured the
      // post-save archival below replaces it with a B2 key (irisCodeUrl) and
      // clears the inline blob. sourcePdfUrl (Telegram-archived source) is set
      // directly since those bytes are already in B2.
      const inlineIris = irisCodeBase64
        ? `data:image/png;base64,${irisCodeBase64}`
        : undefined;

      const buildBill = () =>
        new Collections.Bill({
          realmId,
          buildingId,
          expenseId,
          provider,
          billingId,
          totalAmount,
          periodStart: new Date(periodStart),
          periodEnd: new Date(periodEnd),
          issueDate: issueDate ? new Date(issueDate) : undefined,
          dueDate: dueDate ? new Date(dueDate) : undefined,
          term,
          rfCode,
          paymentCode: paymentCode || null,
          irisCodeUrl: inlineIris,
          pdfUrl: sourcePdfUrl || undefined,
          // Slice 6 — raw OCR text for receipt matching (single source of truth;
          // the matcher rebuilds the element bag from this at match time).
          ocrText: ocrText || undefined,
          status: 'pending',
          createdDate: new Date(),
          updatedDate: new Date()
        });

      let bill = buildBill();
      try {
        await bill.save();
      } catch (err: any) {
        // Duplicate-key on the (realmId, buildingId, expenseId, term) unique
        // index — translate into a proper 409 unless the caller asked to
        // replace, in which case delete-and-retry once.
        if (err && err.code === 11000) {
          if (replaceExisting) {
            await Collections.Bill.deleteOne({
              realmId,
              buildingId,
              expenseId,
              term
            });
            bill = buildBill();
            await bill.save();
          } else {
            throw new ServiceError(
              'A bill already exists for this period. Use replaceExisting:true to overwrite.',
              409
            );
          }
        } else {
          throw err;
        }
      }

      // Slice 5: archive the IRIS QR PNG to B2 (best-effort). On success,
      // replace the inline data-URI with the B2 key and drop the base64 blob
      // so the Bill doc doesn't carry a fat inline image. A failure leaves the
      // inline QR intact — archival is never allowed to fail the confirm.
      if (b2On && irisCodeBase64) {
        try {
          const key = billStorage.billObjectKey(
            realmName,
            String(realmId),
            String(bill._id),
            'iris-qr.png'
          );
          await billStorage.uploadBuffer(
            b2Config,
            key,
            Buffer.from(irisCodeBase64, 'base64'),
            'image/png'
          );
          bill.irisCodeUrl = key;
          (bill as any).irisCodeBase64 = undefined;
          await bill.save();
        } catch (err: any) {
          logger.error(
            `bill ${bill._id} QR archive failed (kept inline): ${err?.message || err}`
          );
        }
      }
      // «Χρέωση ενοικιαστών» — bridge the amount into the tenant-charge engine.
      // Runs AFTER the Bill doc is saved so a bridge failure never blocks the
      // tracking record. Best-effort: the Bill exists regardless; the charge can
      // be retried from the building's monthly statement.
      let chargeError: string | undefined;
      if (chargeThisMonth) {
        try {
          await bridgeChargeToStatement(
            realmId,
            buildingId,
            expenseId,
            term,
            Number(totalAmount),
            expenseName || provider || 'Bill'
          );
        } catch (err: any) {
          const reason =
            err?.response?.data?.message || err?.message || String(err);
          logger.error(
            `bridgeChargeToStatement failed for bill ${bill._id}: ${reason}`
          );
          chargeError = reason;
        }
      }

      // H2: merge chargeError into the RETURNED object out-of-band. Setting it on
      // the Mongoose doc then calling toObject() strips it (not a schema path), so
      // the client would never learn the charge silently failed. Spread the object
      // and add the flag after toObject().
      saved.push(
        chargeError
          ? { ...bill.toObject(), chargeRequested: true, chargeError }
          : chargeThisMonth
            ? { ...bill.toObject(), chargeRequested: true, charged: true }
            : bill.toObject()
      );
    } catch (err: any) {
      // Index-aligned failure record. status carried through so the client can
      // distinguish a 409 duplicate ("already exists") from a real error.
      const status =
        err instanceof ServiceError ? (err as any).statusCode : undefined;
      const reason = err?.message || String(err);
      logger.error(
        `confirmBills failed for one bill (building ${buildingId}, expense ${expenseId}, term ${term}): ${reason}`
      );
      saved.push({ saveFailed: true, status, error: reason });
    }
  }

  res.json(saved);
}

/**
 * POST /bills/:id/attach-source  (multipart, field "source")
 * Slice 5 — upload-dialog path. The source PDF/photo is a multer buffer that
 * only lives during /bills/parse; the JSON /confirm can't carry it (100kb body
 * cap). So the client re-sends the source here AFTER confirm returns a bill id,
 * and only for a bill that actually saved — no orphaned uploads. Best-effort:
 * a B2 failure returns 200 with archived:false; the Bill is untouched.
 */
export async function attachBillSource(req: Req, res: Res): Promise<void> {
  const realmId = req.realm?._id;
  if (!realmId) {
    throw new ServiceError('Unauthorized', 401);
  }
  const { id } = req.params;
  validateObjectId(id, 'bill id');

  const bill: any = await Collections.Bill.findOne({ _id: id, realmId });
  if (!bill) {
    throw new ServiceError('Ο λογαριασμός δεν βρέθηκε', 404);
  }

  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file?.buffer?.length) {
    throw new ServiceError('Δεν βρέθηκε αρχείο πηγής', 422);
  }

  const b2Config = (req.realm as any)?.thirdParties?.b2;
  if (!billStorage.isEnabled(b2Config)) {
    // B2 not configured — nothing to archive to. Not an error; the source
    // simply isn't persisted (matches the inline-only behavior elsewhere).
    res.json({ archived: false });
    return;
  }

  try {
    const realmName = String((req.realm as any)?.name || '');
    const key = billStorage.billObjectKey(
      realmName,
      String(realmId),
      String(bill._id),
      file.originalname || 'source'
    );
    const ct = /\.pdf$/i.test(file.originalname || '')
      ? 'application/pdf'
      : file.mimetype || 'image/jpeg';
    await billStorage.uploadBuffer(b2Config, key, file.buffer, ct);
    bill.pdfUrl = key;
    bill.updatedDate = new Date();
    await bill.save();
    res.json({ archived: true, pdfUrl: key });
  } catch (err: any) {
    logger.error(
      `attachBillSource: B2 upload failed for bill ${bill._id}: ${err?.message || err}`
    );
    res.json({ archived: false });
  }
}

// Which long-key targets are present-but-broken: an RF/IBAN-SHAPED token
// appears in the text but no checksum-valid one of that kind survived
// extraction (Tier-1 already tried). These are what the UI offers Tier-2
// re-capture for. Returns e.g. ['rf'] or ['iban'] or [].
function _invalidLongKeys(text: string, el: BillElements): ('rf' | 'iban')[] {
  const out: ('rf' | 'iban')[] = [];
  const t = text || '';
  if (/RF[0-9][0-9][A-Z0-9 ]{1,30}/i.test(t) && el.rfCodes.length === 0) {
    out.push('rf');
  }
  if (/[A-Z]{2}[0-9]{2}[A-Z0-9 ]{11,40}/i.test(t) && el.ibans.length === 0) {
    out.push('iban');
  }
  return out;
}

// Tier-1 field recovery (§15): when an image receipt yields NO checksum-valid
// RF/IBAN but its text carries an RF/IBAN-SHAPED token that failed the
// checksum (classic OCR digit-drop on a shrunk long line), re-OCR that line's
// band from the ORIGINAL full-res image in isolation and re-validate. Returns
// any recovered valid tokens to merge into the receipt element bag. Best-effort.
async function _recoverLongKeys(
  imageBuffer: Buffer,
  text: string
): Promise<{ rfCodes: string[]; ibans: string[] }> {
  const { extractRFs, extractIBANs } = await import('./billparser/matching.js');
  // Only bother if the text HAS an RF/IBAN-shaped token that failed checksum.
  const rfShaped = /RF[0-9][0-9][A-Z0-9 ]{1,30}/i.test(text);
  const ibanShaped = /[A-Z]{2}[0-9]{2}[A-Z0-9 ]{11,40}/i.test(text);
  if (!rfShaped && !ibanShaped) return { rfCodes: [], ibans: [] };

  try {
    const { ocrImageWithBoxes, recropAndOcr } = await import(
      './billparser/ocr.js'
    );
    const { lines } = await ocrImageWithBoxes(imageBuffer);
    const rfOut = new Set<string>();
    const ibanOut = new Set<string>();
    for (const line of lines) {
      const looksRf = /RF[0-9][0-9][A-Z0-9 ]{1,30}/i.test(line.text);
      const looksIban = /[A-Z]{2}[0-9]{2}[A-Z0-9 ]{11,40}/i.test(line.text);
      if (!looksRf && !looksIban) continue;
      // Already valid as-is? nothing to recover on this line.
      if (extractRFs(line.text).length || extractIBANs(line.text).length) {
        continue;
      }
      const recovered = await recropAndOcr(imageBuffer, line);
      for (const rf of extractRFs(recovered)) rfOut.add(rf);
      for (const ib of extractIBANs(recovered)) ibanOut.add(ib);
    }
    return { rfCodes: [...rfOut], ibans: [...ibanOut] };
  } catch (err: any) {
    logger.warn(`Tier-1 recrop failed: ${err?.message || err}`);
    return { rfCodes: [], ibans: [] };
  }
}

// Read text from a receipt file: digital PDF → pdfjs text layer; scanned PDF or
// image → OCR (reuses the same pipeline as bill parsing). Returns '' on failure.
async function _receiptText(file: Express.Multer.File): Promise<string> {
  const buf = file.buffer;
  const isPdf =
    buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === '%PDF';
  if (isPdf) {
    try {
      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const doc = await getDocument({ data: new Uint8Array(buf) }).promise;
      let text = '';
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        text += content.items.map((it: any) => it.str).join(' ') + '\n';
      }
      // Scanned PDF (no text layer) → OCR its rasterized pages.
      if (text.replace(/\s/g, '').length < 30) {
        const { rasterizePdfToImages, ocrImage } = await import(
          './billparser/ocr.js'
        );
        const pages = await rasterizePdfToImages(buf);
        const parts: string[] = [];
        for (const png of pages) parts.push(await ocrImage(png));
        text = parts.join('\n');
      }
      return text;
    } catch (err: any) {
      logger.error(`receipt PDF read failed: ${err?.message || err}`);
      return '';
    }
  }
  // Image (JPEG/PNG/WEBP) → OCR.
  try {
    const { ocrImage } = await import('./billparser/ocr.js');
    return await ocrImage(buf);
  } catch (err: any) {
    logger.error(`receipt OCR failed: ${err?.message || err}`);
    return '';
  }
}

/**
 * POST /bills/payment-receipt  (multipart, field "bills"; PDFs or images)
 * Slice 6 — OCR/parse each receipt, extract its element bag, and SCORE it
 * against every candidate bill (pending or partial — i.e. not fully paid).
 * Returns, per receipt: the recognized fields (editable client-side) + a ranked
 * list of candidate bills with the top one pre-selected (soft suggestion), plus
 * WHICH keys matched — never an auto-apply. Accepts images now (phone photos),
 * not just digital PDFs.
 */
export async function parsePaymentReceipts(req: Req, res: Res): Promise<void> {
  const realmId = req.realm?._id;
  if (!realmId) {
    throw new ServiceError('Unauthorized', 401);
  }

  const files = (req as any).files as Express.Multer.File[];
  if (!files || files.length === 0) {
    throw new ServiceError('Δεν βρέθηκαν αρχεία', 422);
  }

  // Candidate set — UNIFIED across two kinds, because a receipt may pay a
  // utility bill OR a repair (an επισκευές απόδειξη carries NO RF/IBAN; its
  // contractor NAME is the key). Both are scored with the same fuzzy scorer:
  //   1. Bills not fully paid — element bag rebuilt from the stored ocrText.
  //   2. Repairs with a real cost, not cancelled, not already fully paid by a
  //      linked receipt — element bag derived live from the contractor + fields.
  type Candidate = {
    kind: 'bill' | 'repair';
    id: string;
    buildingId: string;
    keys: any;
    dates: { issueDate?: Date; dueDate?: Date };
    display: any;
  };

  const bills: any[] = await Collections.Bill.find({
    realmId,
    status: { $in: ['pending', 'partial'] }
  }).lean();

  const buildingsAll: any[] = await Collections.Building.find({
    realmId
  }).lean();
  const buildingById = new Map(buildingsAll.map((b) => [String(b._id), b]));

  const paidSum = (receipts: any[]) =>
    (receipts || []).reduce(
      (s: number, r: any) => s + (Number(r.amount) || 0),
      0
    );

  const candidates: Candidate[] = [];

  for (const bill of bills) {
    const building = buildingById.get(String(bill.buildingId));
    const expense = building?.expenses?.find(
      (e: any) => String(e._id) === String(bill.expenseId)
    );
    const paidSoFar = paidSum(bill.receipts);
    // Rebuild the candidate's element bag from its stored raw text + structured
    // fields (incl. the STRONG billingId/RF keys), so it carries the full
    // soft-TF-IDF token bag the scorer needs — not the older persisted shape.
    const keys = extractElements(bill.ocrText || '', {
      amount: bill.totalAmount,
      dates: [bill.periodStart, bill.periodEnd, bill.issueDate, bill.dueDate]
        .filter(Boolean)
        .map((d: any) => new Date(d)),
      name: expense?.name || bill.provider,
      billingIds: [bill.billingId, bill.rfCode].filter(Boolean)
    });
    // Fold the bill's own strong keys into the bag explicitly (in case ocrText
    // was absent — e.g. legacy bills imported before Slice 6 stored raw text).
    // extractElements already emits these when ocrText is present; the guarded
    // Set-dedup in tokenizeAll means the duplicate push is harmless. Emit BOTH
    // n: (cosine) and pn: (strong-ID marker) for the billingId so the strong
    // floor still fires for a legacy bill whose only source is this fold.
    if (bill.rfCode)
      keys.tokens.push(`rf:${String(bill.rfCode).toUpperCase()}`);
    if (bill.billingId) {
      const c = String(bill.billingId).replace(/[\s\-.]/g, '');
      if (c) {
        keys.tokens.push(`n:${c}`);
        keys.tokens.push(`pn:${c}`);
      }
    }
    // Dedup the token bag after the fold — a duplicate token would otherwise
    // inflate the cosine magnitude (the scorer assumes a Set-like binary TF).
    keys.tokens = Array.from(new Set(keys.tokens));
    candidates.push({
      kind: 'bill',
      id: String(bill._id),
      buildingId: String(bill.buildingId),
      keys,
      dates: {
        issueDate: bill.issueDate ? new Date(bill.issueDate) : undefined,
        dueDate: bill.dueDate ? new Date(bill.dueDate) : undefined
      },
      display: {
        kind: 'bill',
        billId: String(bill._id),
        buildingName: building?.name || 'Άγνωστο',
        expenseName: expense?.name || 'Άγνωστο',
        totalAmount: bill.totalAmount,
        paidSoFar,
        remaining: Math.round((bill.totalAmount - paidSoFar) * 100) / 100,
        term: bill.term
      }
    });
  }

  for (const building of buildingsAll) {
    const contractors = building.contractors || [];
    for (const repair of building.repairs || []) {
      const cost = Number(repair.actualCost) || 0;
      if (cost <= 0 || repair.status === 'cancelled') continue;
      const paidSoFar = paidSum(repair.receipts);
      if (paidSoFar + 0.005 >= cost) continue; // already fully receipted
      const contractor =
        contractors.find(
          (c: any) => String(c._id) === String(repair.contractorId)
        ) || null;
      candidates.push({
        kind: 'repair',
        id: String(repair._id),
        buildingId: String(building._id),
        keys: repairMatchKeys(repair, contractor),
        dates: {
          issueDate: repair.startDate ? new Date(repair.startDate) : undefined,
          dueDate: repair.completionDate
            ? new Date(repair.completionDate)
            : undefined
        },
        display: {
          kind: 'repair',
          repairId: String(repair._id),
          buildingId: String(building._id),
          buildingName: building.name || 'Άγνωστο',
          expenseName: repair.title || 'Επισκευή',
          contractorName: contractor?.company || contractor?.name || '',
          totalAmount: cost,
          paidSoFar,
          remaining: Math.round((cost - paidSoFar) * 100) / 100
        }
      });
    }
  }

  // IDF over the candidate corpus (bills + repairs). Computed ONCE per request
  // so token weights reflect how discriminating each token is across THIS
  // realm's open items — rare tokens (a surname, invoice #, specific amount)
  // outweigh ubiquitous ones (ΕΥΡΩ, ΠΟΣΟ). This is the "data decides
  // importance, not hard categories" core of the soft-TF-IDF match.
  const idf = computeIdf(candidates.map((c) => c.keys));

  const results = [];
  for (const file of files) {
    const text = await _receiptText(file);
    if (!text || !text.trim()) {
      results.push({
        filename: file.originalname,
        success: false,
        error: 'Αποτυχία ανάγνωσης αρχείου'
      });
      continue;
    }

    let receiptEl = extractElements(text);

    // Tier-1 recovery: if this is an IMAGE and no checksum-valid long key
    // surfaced, re-crop the RF/IBAN band from the full-res original and retry.
    const isImage = !(
      file.buffer.length >= 4 &&
      file.buffer.subarray(0, 4).toString('ascii') === '%PDF'
    );
    if (
      isImage &&
      receiptEl.rfCodes.length === 0 &&
      receiptEl.ibans.length === 0
    ) {
      const recovered = await _recoverLongKeys(file.buffer, text);
      if (recovered.rfCodes.length || recovered.ibans.length) {
        // Re-extract with the recovered tokens appended to the text so they
        // flow into both the strong-key lists AND the token bag consistently.
        receiptEl = extractElements(
          text + ' ' + [...recovered.rfCodes, ...recovered.ibans].join(' ')
        );
      }
    }

    // The receipt's own recognized amount = the largest money token (a receipt
    // shows the paid total; line items are smaller). Editable client-side.
    const receiptAmount = receiptEl.amounts.length
      ? Math.max(...receiptEl.amounts)
      : undefined;
    const receiptDate = receiptEl.dates.length
      ? receiptEl.dates.slice().sort((a, b) => b.getTime() - a.getTime())[0]
      : undefined;

    // Score every candidate (bills + repairs) with the SAME soft-TF-IDF token
    // comparison — no hard categories. Keep those with any weighted overlap,
    // best first. `strong` flags an exact RF/IBAN/billingId hit.
    const ranked = candidates
      .map((cand) => {
        const s = scoreTokens(cand.keys, receiptEl, idf);
        return { cand, ...s };
      })
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((c) => ({
        ...c.cand.display,
        score: Math.round(c.score * 100) / 100,
        matchedOn: c.matchedOn,
        strong: c.strong
      }));

    results.push({
      filename: file.originalname,
      success: true,
      recognized: {
        amount: receiptAmount,
        date: receiptDate,
        rfCodes: receiptEl.rfCodes,
        ibans: receiptEl.ibans,
        afm: receiptEl.afm,
        // Flag long-key checksum health for the UI (all extracted RF/IBAN are
        // already checksum-valid; a receipt that had NONE survive is a hint the
        // OCR mangled them → Tier 1/2 recovery is offered).
        hasValidLongKey:
          receiptEl.rfCodes.length > 0 || receiptEl.ibans.length > 0,
        // Tier-2 trigger: an RF/IBAN-SHAPED token was present but failed its
        // checksum (Tier-1 re-crop already tried) → the UI offers «Θα στείλω
        // άλλη φωτογραφία» for these targets. Empty when nothing was broken.
        invalidLongKeys: _invalidLongKeys(text, receiptEl)
      },
      ocrText: text.slice(0, 4000),
      candidates: ranked
    });
  }

  res.json(results);
}

/**
 * POST /bills/confirm-payment
 * Slice 6 — record a receipt as an installment on a bill (receipts[] append),
 * recompute status: 'paid' when Σ(receipts) >= totalAmount else 'partial'.
 * Body accepts either the new shape { payments: [{billId, amount, date,
 * proofUrl, matchedOn}] } OR the legacy { billIds, paymentProofUrl } (marks
 * each bill fully paid) for back-compat with the pre-Slice-6 caller.
 */
export async function confirmPayment(req: Req, res: Res): Promise<void> {
  const realmId = req.realm?._id;
  if (!realmId) {
    throw new ServiceError('Unauthorized', 401);
  }

  const { payments, billIds, paymentProofUrl } = req.body;

  // Legacy path: mark each bill fully paid (no installment record).
  if (Array.isArray(billIds) && billIds.length) {
    const result = await Collections.Bill.updateMany(
      {
        _id: { $in: billIds },
        realmId,
        status: { $in: ['pending', 'partial'] }
      },
      {
        $set: {
          status: 'paid',
          paymentProofUrl: paymentProofUrl || undefined,
          paymentDate: new Date(),
          updatedDate: new Date()
        }
      }
    );
    res.json({ modifiedCount: result.modifiedCount });
    return;
  }

  if (!Array.isArray(payments) || payments.length === 0) {
    throw new ServiceError('Δεν βρέθηκαν πληρωμές', 422);
  }

  // Every installment MUST carry an explicit positive amount. The old code
  // silently fell back to the target's FULL total when the amount was missing
  // (OCR failed to read it AND the user didn't type one) — which recorded a
  // fabricated full payment and auto-marked the bill 'paid'. A receipt with no
  // legible amount is a data problem the user must resolve, not a full payment.
  // Validate the whole batch up front so a bad amount never mutates anything.
  const parseAmount = (p: any): number => {
    const a = Number(p?.amount);
    return Number.isFinite(a) && a > 0 ? a : NaN;
  };
  const badAmounts = payments.filter((p: any) => Number.isNaN(parseAmount(p)));
  if (badAmounts.length) {
    throw new ServiceError(
      'Κάθε πληρωμή πρέπει να έχει ποσό μεγαλύτερο του μηδενός. Συμπληρώστε το ποσό της απόδειξης.',
      422
    );
  }

  const mkReceipt = (p: any) => ({
    amount: parseAmount(p),
    date: p.date ? new Date(p.date) : new Date(),
    proofUrl: p.proofUrl || undefined,
    ocrText: p.ocrText || undefined,
    matchedOn: Array.isArray(p.matchedOn) ? p.matchedOn : [],
    createdDate: new Date()
  });

  // Idempotency: a double-submit (double-click, retry after a timed-out
  // response, re-upload of the same file) must not record the same απόδειξη
  // twice and double-count Σ(receipts). Two receipts are "the same" when they
  // share amount + same calendar day + same proof identity (proofUrl, else the
  // OCR text). Returns true if an equivalent receipt already exists.
  const dayKey = (d: any) => {
    const t = d ? new Date(d) : null;
    return t && !Number.isNaN(t.getTime())
      ? t.toISOString().slice(0, 10)
      : '';
  };
  const isDuplicateReceipt = (existing: any[], r: any): boolean =>
    (existing || []).some(
      (e: any) =>
        Math.abs((Number(e.amount) || 0) - r.amount) < 0.005 &&
        dayKey(e.date) === dayKey(r.date) &&
        (r.proofUrl
          ? e.proofUrl === r.proofUrl
          : (e.ocrText || '') === (r.ocrText || ''))
    );

  const updated = [];
  for (const p of payments) {
    // REPAIR installment — the receipt pays a building repair (contractor
    // απόδειξη). Update the repairs[] subdoc in place.
    if (p?.kind === 'repair') {
      validateObjectId(p?.repairId, 'repairId');
      validateObjectId(p?.buildingId, 'buildingId');
      const building: any = await Collections.Building.findOne({
        _id: p.buildingId,
        realmId
      });
      const repair: any = building?.repairs?.id
        ? building.repairs.id(p.repairId)
        : (building?.repairs || []).find(
            (r: any) => String(r._id) === String(p.repairId)
          );
      if (!repair) continue;
      const cost = Number(repair.actualCost) || 0;
      // A repair with no real cost can't be "paid" — without this guard a
      // 0-cost repair + any receipt trips paid+0.005 >= 0 → instantly marked
      // fully paid from the repairs fund. parsePaymentReceipts already excludes
      // 0-cost repairs as candidates, but a direct confirm call would not.
      if (cost <= 0) {
        throw new ServiceError(
          'Η επισκευή δεν έχει καταχωρημένο κόστος — καταχωρήστε το πραγματικό κόστος πρώτα.',
          422
        );
      }
      const receipt = mkReceipt(p);
      repair.receipts = repair.receipts || [];
      if (isDuplicateReceipt(repair.receipts, receipt)) {
        updated.push({
          kind: 'repair',
          repairId: String(repair._id),
          duplicate: true
        });
        continue;
      }
      repair.receipts.push(receipt);
      const paid = repair.receipts.reduce(
        (s: number, r: any) => s + (Number(r.amount) || 0),
        0
      );
      const fullyPaid = paid + 0.005 >= cost;
      if (fullyPaid) repair.isPaidFromRepairsFund = true;
      building.updatedDate = new Date();
      // The receipts[] subdoc array is nested two levels deep (building →
      // repairs[] → receipts[]). Mongoose does not always detect a push into a
      // nested array on a re-fetched doc, so mark the path explicitly or the
      // save is a silent no-op (the installment vanishes).
      building.markModified('repairs');
      try {
        await building.save();
      } catch (err: any) {
        logger.error(
          `confirmPayment: repair ${p.repairId} save failed: ${err?.message || err}`
        );
        throw new ServiceError(
          `Αποτυχία αποθήκευσης πληρωμής επισκευής: ${err?.message || err}`,
          500
        );
      }
      updated.push({
        kind: 'repair',
        repairId: String(repair._id),
        fullyPaid,
        paidSoFar: Math.round(paid * 100) / 100,
        remaining: Math.round((cost - paid) * 100) / 100
      });
      continue;
    }

    // BILL installment (default).
    validateObjectId(p?.billId, 'billId');
    const bill: any = await Collections.Bill.findOne({
      _id: p.billId,
      realmId
    });
    if (!bill) continue;

    const receipt = mkReceipt(p);
    bill.receipts = bill.receipts || [];
    if (isDuplicateReceipt(bill.receipts, receipt)) {
      updated.push({
        kind: 'bill',
        billId: String(bill._id),
        status: bill.status,
        duplicate: true
      });
      continue;
    }
    bill.receipts.push(receipt);

    const paid = bill.receipts.reduce(
      (s: number, r: any) => s + (Number(r.amount) || 0),
      0
    );
    // Sub-cent tolerance so 33,33×3 vs 100,00 doesn't leave a bill "partial".
    bill.status = paid + 0.005 >= bill.totalAmount ? 'paid' : 'partial';
    if (bill.status === 'paid') bill.paymentDate = new Date();
    // Keep the single-field mirror pointing at the latest proof (back-compat).
    if (receipt.proofUrl) bill.paymentProofUrl = receipt.proofUrl;
    bill.updatedDate = new Date();
    await bill.save();
    updated.push({
      kind: 'bill',
      billId: String(bill._id),
      status: bill.status,
      paidSoFar: Math.round(paid * 100) / 100,
      remaining: Math.round((bill.totalAmount - paid) * 100) / 100
    });
  }

  res.json({ updated });
}

/**
 * POST /bills/recapture/start  { target: 'rf' | 'iban' }
 * Tier-2 (Slice 6 §15). Opens a re-capture session: the user is about to send a
 * zoomed close-up of a checksum-failed RF/IBAN to the Telegram bot. The poller
 * routes the NEXT admin-chat photo to this session (see telegramInboxScanner
 * tryRecapture). Returns a session id the dialog then polls.
 */
export async function startRecapture(req: Req, res: Res): Promise<void> {
  const realmId = req.realm?._id;
  if (!realmId) {
    throw new ServiceError('Unauthorized', 401);
  }
  const target = req.body?.target === 'iban' ? 'iban' : 'rf';
  const { startSession } = await import('./recapturesession.js');
  const id = `${realmId}-${Date.now()}-${Math.floor(
    // eslint-disable-next-line no-bitwise
    (typeof performance !== 'undefined' ? performance.now() : Date.now()) % 1e6
  )}`;
  const s = startSession(String(realmId), target, Date.now(), id);
  res.json({ id: s.id, target: s.target, expiresAt: s.expiresAt });
}

/**
 * GET /bills/recapture/:id
 * Poll a re-capture session. Returns { status: 'waiting'|'recovered'|'timeout',
 * value? }. The dialog polls until recovered (updates the field, red→green) or
 * timeout (~2 min; field stays manually editable).
 */
export async function pollRecapture(req: Req, res: Res): Promise<void> {
  const realmId = req.realm?._id;
  if (!realmId) {
    throw new ServiceError('Unauthorized', 401);
  }
  const { getSession } = await import('./recapturesession.js');
  const s = getSession(String(req.params.id), Date.now());
  if (!s || String(s.realmId) !== String(realmId)) {
    throw new ServiceError('Η συνεδρία λήψης δεν βρέθηκε', 404);
  }
  res.json({ status: s.status, value: s.value, target: s.target });
}

/**
 * GET /bills
 * List bills with optional filters: buildingId, status, term, expenseId.
 */
export async function list(req: Req, res: Res): Promise<void> {
  const realmId = req.realm?._id;
  if (!realmId) {
    throw new ServiceError('Unauthorized', 401);
  }

  const { buildingId, status, term, expenseId } = req.query as any;
  const filter: any = { realmId };
  if (buildingId) {
    validateObjectId(buildingId, 'buildingId');
    filter.buildingId = buildingId;
  }
  if (status) filter.status = status;
  if (term) filter.term = Number(term);
  if (expenseId) {
    validateObjectId(expenseId, 'expenseId');
    filter.expenseId = expenseId;
  }

  const bills = await Collections.Bill.find(filter)
    .sort({ createdDate: -1 })
    .lean();

  res.json(bills);
}

/**
 * GET /bills/:id
 * Get a single bill by ID.
 */
export async function one(req: Req, res: Res): Promise<void> {
  const realmId = req.realm?._id;
  if (!realmId) {
    throw new ServiceError('Unauthorized', 401);
  }

  const bill = await Collections.Bill.findOne({
    _id: req.params.id,
    realmId
  }).lean();

  if (!bill) {
    throw new ServiceError('Ο λογαριασμός δεν βρέθηκε', 404);
  }

  res.json(bill);
}

/**
 * DELETE /bills/:id
 * Delete a bill scoped to the caller's realm.
 */
export async function remove(req: Req, res: Res): Promise<void> {
  const realmId = req.realm?._id;
  if (!realmId) {
    throw new ServiceError('Unauthorized', 401);
  }

  validateObjectId(req.params.id, 'bill id');
  const result = await Collections.Bill.deleteOne({
    _id: req.params.id,
    realmId
  });
  if (result.deletedCount === 0) {
    throw new ServiceError('Bill not found', 404);
  }
  res.sendStatus(200);
}
