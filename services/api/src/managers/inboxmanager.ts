/**
 * Inbox routes — Slice 4 (§6.3 of the bill-OCR plan).
 *
 * InboxItems are bills that arrived out-of-band (Telegram bot photos/documents,
 * written by jobs/telegramInboxScanner.ts). The landlord sees them in the
 * notification bell and either confirms (→ becomes a Bill through the SAME
 * confirmBills pipeline as the import dialog — validation, duplicate-409,
 * charge bridge all included) or dismisses.
 *
 * Confirm/dismiss set `status` instead of deleting (deviation from plan §6.3's
 * "delete", resolved in favor of the plan's own schema which enumerates
 * confirmed/dismissed): deleting would break the telegramMessageId dedup
 * (a re-polled message would re-ingest after its item vanished) and loses the
 * audit trail Slice 6 (receipt matching) wants. GET /inbox returns pending
 * only, so bell behavior is identical.
 */
import { Collections, ServiceError } from '@microrealestate/common';
import type { ServiceRequest, ServiceResponse } from '@microrealestate/types';
import { confirmBills } from './billmanager.js';
import { validateObjectId } from '../validators.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = ServiceRequest<any, any, any>;
type Res = ServiceResponse;

/** GET /inbox — pending items for the realm, newest first. */
export async function list(req: Req, res: Res): Promise<void> {
  const realmId = req.realm?._id;
  if (!realmId) {
    throw new ServiceError('Unauthorized', 401);
  }
  const items = await Collections.InboxItem.find({
    realmId,
    status: 'pending'
  })
    .sort({ createdDate: -1 })
    .lean();
  res.json(items);
}

/**
 * POST /inbox/:id/confirm
 * Body: {buildingId, expenseId, chargeThisMonth?, replaceExisting?,
 *        [amended parsed fields: totalAmount, term, periodStart, periodEnd,
 *         issueDate, dueDate, expenseName]}.
 * Reuses the confirmBills pipeline verbatim by dispatching a one-bill batch
 * with a captured response — every validation, the duplicate-409 and the
 * charge bridge behave exactly as in the import dialog.
 */
export async function confirm(req: Req, res: Res): Promise<void> {
  const realmId = req.realm?._id;
  if (!realmId) {
    throw new ServiceError('Unauthorized', 401);
  }
  const { id } = req.params;
  validateObjectId(id, 'inbox item id');

  const item: any = await Collections.InboxItem.findOne({
    _id: id,
    realmId,
    status: 'pending'
  }).lean();
  if (!item) {
    throw new ServiceError('Το στοιχείο εισερχομένων δεν βρέθηκε', 404);
  }

  const {
    buildingId,
    expenseId,
    chargeThisMonth,
    replaceExisting,
    expenseName,
    // Optional amendments — the bell card lets the landlord correct OCR slips
    // before confirming, same as the import dialog's editable fields.
    totalAmount,
    term,
    periodStart,
    periodEnd,
    issueDate,
    dueDate
  } = req.body || {};
  validateObjectId(buildingId, 'buildingId');
  validateObjectId(expenseId, 'expenseId');

  const p = item.parsed || {};
  const billPayload = {
    buildingId,
    expenseId,
    provider: p.provider || 'other',
    billingId: p.billingId,
    totalAmount: totalAmount !== undefined ? totalAmount : p.totalAmount,
    periodStart: periodStart !== undefined ? periodStart : p.periodStart,
    periodEnd: periodEnd !== undefined ? periodEnd : p.periodEnd,
    issueDate: issueDate !== undefined ? issueDate : p.issueDate,
    dueDate: dueDate !== undefined ? dueDate : p.dueDate,
    term: term !== undefined ? term : p.proposedTerm,
    rfCode: p.rfCode,
    paymentCode: p.paymentCode,
    irisCodeBase64: item.irisCodeBase64,
    replaceExisting: !!replaceExisting,
    chargeThisMonth: !!chargeThisMonth,
    expenseName
  };

  // Internal dispatch: same req (auth/realm context preserved), captured res.
  const captured: { body?: any } = {};
  const fakeRes = {
    json: (x: any) => {
      captured.body = x;
    }
  } as unknown as Res;
  const innerReq = Object.create(req);
  innerReq.body = { bills: [billPayload] };
  await confirmBills(innerReq, fakeRes);

  const row = Array.isArray(captured.body) ? captured.body[0] : undefined;
  if (!row || row.saveFailed) {
    // Surface the per-bill failure as a proper HTTP error — the item stays
    // pending so the landlord can amend and retry (or dismiss).
    throw new ServiceError(
      row?.error || 'Η αποθήκευση του λογαριασμού απέτυχε',
      row?.status || 500
    );
  }

  await Collections.InboxItem.updateOne(
    { _id: id, realmId },
    { $set: { status: 'confirmed', updatedDate: new Date() } }
  );

  // Same response shape as confirmBills' rows — the client reads chargeError
  // the same way the import dialog does.
  res.json(row);
}

/** POST /inbox/:id/dismiss — the item disappears from the bell. */
export async function dismiss(req: Req, res: Res): Promise<void> {
  const realmId = req.realm?._id;
  if (!realmId) {
    throw new ServiceError('Unauthorized', 401);
  }
  const { id } = req.params;
  validateObjectId(id, 'inbox item id');

  const updated = await Collections.InboxItem.updateOne(
    { _id: id, realmId, status: 'pending' },
    { $set: { status: 'dismissed', updatedDate: new Date() } }
  );
  if (!updated.matchedCount) {
    throw new ServiceError('Το στοιχείο εισερχομένων δεν βρέθηκε', 404);
  }
  res.json({ ok: true });
}
