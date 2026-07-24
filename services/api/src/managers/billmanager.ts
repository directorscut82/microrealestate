import { Collections, logger, ServiceError, Service } from '@microrealestate/common';
import type { ServiceRequest, ServiceResponse } from '@microrealestate/types';
import {
  parseBillPdf,
  generateIrisQr,
  normalizeBillingId
} from './billparser/index.js';
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
    const parseResult = await parseBillPdf(file.buffer);

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
        proposedTerm: computeDefaultTerm(bill.periodEnd)
      },
      match: match
        ? {
            buildingId: String(match.building._id),
            buildingName: match.building.name,
            expenseId: String(match.expense._id),
            expenseName: match.expense.name
          }
        : null,
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
      replaceExisting,
      chargeThisMonth,
      expenseName
    } = billData;

    // Verify building belongs to this realm
    const building = await Collections.Building.findOne({
      _id: buildingId,
      realmId
    }).lean();
    if (!building) {
      throw new ServiceError(
        `Το κτίριο ${buildingId} δεν βρέθηκε`,
        404
      );
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
      throw new ServiceError(`Bill term out of valid range (got ${term})`, 422);
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

    // If replacing, remove existing bill for same term+expense
    if (replaceExisting) {
      await Collections.Bill.deleteMany({
        realmId,
        buildingId,
        expenseId,
        term
      });
    }

    // Store IRIS QR as data URI if provided (B2 upload can replace later)
    const irisCodeUrl = irisCodeBase64
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
        irisCodeUrl,
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
  }

  res.json(saved);
}

/**
 * POST /bills/payment-receipt
 * Parse payment receipt PDFs, extract RF codes, match to pending bills.
 * Returns matches for user confirmation.
 */
export async function parsePaymentReceipts(
  req: Req,
  res: Res
): Promise<void> {
  const realmId = req.realm?._id;
  if (!realmId) {
    throw new ServiceError('Unauthorized', 401);
  }

  const files = (req as any).files as Express.Multer.File[];
  if (!files || files.length === 0) {
    throw new ServiceError('Δεν βρέθηκαν αρχεία PDF', 422);
  }

  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const results = [];

  for (const file of files) {
    let text = '';
    try {
      const data = new Uint8Array(file.buffer);
      const doc = await getDocument({ data }).promise;
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        text += content.items.map((item: any) => item.str).join(' ') + '\n';
      }
    } catch (error) {
      results.push({
        filename: file.originalname,
        success: false,
        error: `Αποτυχία ανάγνωσης PDF: ${String(error)}`
      });
      continue;
    }

    // Find RF codes in receipt
    const rfMatches = text.match(/RF\d{15,30}/g);
    if (!rfMatches || rfMatches.length === 0) {
      results.push({
        filename: file.originalname,
        success: false,
        error: 'Δεν βρέθηκε κωδικός RF στην απόδειξη'
      });
      continue;
    }

    // Match RF codes to pending bills
    for (const rfCode of rfMatches) {
      const pendingBill = await Collections.Bill.findOne({
        realmId,
        rfCode,
        status: 'pending'
      }).lean();

      if (pendingBill) {
        // Get building/expense names for display
        const building = await Collections.Building.findOne({
          _id: (pendingBill as any).buildingId,
          realmId
        }).lean();
        const expense = building
          ? (building as any).expenses?.find(
              (e: any) =>
                String(e._id) === String((pendingBill as any).expenseId)
            )
          : null;

        results.push({
          filename: file.originalname,
          success: true,
          rfCode,
          billId: String((pendingBill as any)._id),
          buildingName: building ? (building as any).name : 'Άγνωστο',
          expenseName: expense ? expense.name : 'Άγνωστο',
          totalAmount: (pendingBill as any).totalAmount,
          term: (pendingBill as any).term
        });
      } else {
        results.push({
          filename: file.originalname,
          success: false,
          rfCode,
          error: 'Δεν βρέθηκε εκκρεμής λογαριασμός με αυτόν τον κωδικό RF'
        });
      }
    }
  }

  res.json(results);
}

/**
 * POST /bills/confirm-payment
 * Mark bills as paid after user confirmation.
 */
export async function confirmPayment(req: Req, res: Res): Promise<void> {
  const realmId = req.realm?._id;
  if (!realmId) {
    throw new ServiceError('Unauthorized', 401);
  }

  const { billIds, paymentProofUrl } = req.body;
  if (!billIds || !Array.isArray(billIds) || billIds.length === 0) {
    throw new ServiceError('Δεν βρέθηκαν λογαριασμοί', 422);
  }

  const result = await Collections.Bill.updateMany(
    { _id: { $in: billIds }, realmId, status: 'pending' },
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
