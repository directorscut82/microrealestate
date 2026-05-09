import { Collections, logger, ServiceError } from '@microrealestate/common';
import type { ServiceRequest, ServiceResponse } from '@microrealestate/types';
import {
  parseBillPdf,
  extractQrImageFromPdf,
  normalizeBillingId
} from './billparser/index.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = ServiceRequest<any, any, any>;
type Res = ServiceResponse;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeDefaultTerm(periodEnd: Date): number {
  const year = periodEnd.getFullYear();
  const month = periodEnd.getMonth() + 1;
  return year * 1000000 + month * 10000 + 100;
}

async function findExpenseByBillingId(
  realmId: string,
  normalizedBillingId: string
): Promise<{
  building: any;
  expense: any;
} | null> {
  const buildings = await Collections.Building.find({ realmId }).lean();

  for (const building of buildings) {
    for (const expense of building.expenses || []) {
      if (!expense.billingId) continue;
      const expenseNormalized = normalizeBillingId(expense.billingId);
      if (
        expenseNormalized === normalizedBillingId ||
        normalizedBillingId.startsWith(expenseNormalized) ||
        expenseNormalized.startsWith(normalizedBillingId)
      ) {
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

  // Precheck: at least one expense across all buildings has a billingId
  const buildings = await Collections.Building.find({ realmId }).lean();
  const hasAnyBillingId = buildings.some((b: any) =>
    (b.expenses || []).some((e: any) => e.billingId)
  );
  if (!hasAnyBillingId) {
    throw new ServiceError(
      'Δεν υπάρχει δαπάνη με αναγνωριστικό λογαριασμού. Προσθέστε αναγνωριστικό σε τουλάχιστον μία δαπάνη.',
      422
    );
  }

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

    // Extract QR/IRIS image (best effort)
    let irisCodeBase64: string | undefined;
    try {
      const qrBuffer = await extractQrImageFromPdf(file.buffer);
      if (qrBuffer) {
        irisCodeBase64 = qrBuffer.toString('base64');
      }
    } catch (e) {
      logger.debug(`QR extraction failed for ${file.originalname}: ${e}`);
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
 * Save confirmed bills: store PDF in B2/S3, create Bill records,
 * update monthly charges.
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
      irisCodeUrl,
      pdfUrl,
      replaceExisting
    } = billData;

    // If replacing, remove existing bill for same term+expense
    if (replaceExisting) {
      await Collections.Bill.deleteMany({
        realmId,
        buildingId,
        expenseId,
        term
      });
    }

    const bill = new Collections.Bill({
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
      irisCodeUrl,
      pdfUrl,
      status: 'pending',
      createdDate: new Date(),
      updatedDate: new Date()
    });

    await bill.save();
    saved.push(bill.toObject());
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
    // Extract text from receipt
    const data = new Uint8Array(file.buffer);
    const doc = await getDocument({ data }).promise;
    let text = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map((item: any) => item.str).join(' ') + '\n';
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
        const building = await Collections.Building.findById(
          (pendingBill as any).buildingId
        ).lean();
        const expense = building
          ? (building as any).expenses.find(
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
 * List bills with optional filters.
 */
export async function list(req: Req, res: Res): Promise<void> {
  const realmId = req.realm?._id;
  if (!realmId) {
    throw new ServiceError('Unauthorized', 401);
  }

  const { buildingId, status } = req.query as any;
  const filter: any = { realmId };
  if (buildingId) filter.buildingId = buildingId;
  if (status) filter.status = status;

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
