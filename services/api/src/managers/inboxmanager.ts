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
    // Slice 5: carry the source archived at ingest onto the Bill (no re-upload).
    sourcePdfUrl: item.sourcePdfUrl,
    // Slice 6: carry the parsed OCR text so the confirmed Bill can be matched
    // by an incoming απόδειξη (confirmBills builds matchKeys / stores ocrText).
    // Without this, Telegram-imported bills had an empty match bag.
    ocrText: p.ocrText,
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
    // A 409 duplicate needs disambiguation: if a crash landed BETWEEN the Bill
    // save and the status flip below on a PRIOR confirm, the Bill already
    // exists but the item is still pending — so every retry would 409 forever
    // and the item is permanently stranded (ingress+error-path audit 2026-07).
    // Reconcile idempotently, but ONLY when we can PROVE the existing bill is
    // the exact one THIS confirm wrote (Step-7: billingId alone is too weak — it
    // is the αριθμός παροχής, IDENTICAL across every monthly bill for the meter,
    // so matching on it would silently confirm a DIFFERENT bill in the slot,
    // e.g. an έναντι→εκκαθαριστικός clearing bill or a user-AMENDED amount, and
    // discard its data). Require the occupying bill to match BOTH the same
    // billingId AND the exact totalAmount this confirm is submitting: a genuine
    // strand retry replays the identical payload, so both match; a different or
    // amended bill differs in amount → falls through to a safe 409 that forces
    // the landlord to use replaceExisting.
    if (row?.status === 409) {
      const resolvedTerm = term !== undefined ? term : p.proposedTerm;
      const existing: any = await Collections.Bill.findOne({
        realmId,
        buildingId,
        expenseId,
        term: resolvedTerm
      }).lean();
      const itemBillingId = p.billingId;
      const submittedTotal = Number(billPayload.totalAmount);
      // Compare a submitted date field against the occupying bill's. Equal when
      // both are absent, or both parse to the same day (ms tolerance). A
      // mismatch means this confirm carries a DATE amendment the existing bill
      // doesn't have → it is NOT the same bill → fall through to a safe 409 so
      // the amendment isn't silently discarded (Step-7 round-2 LOW residual).
      const sameDate = (a: any, b: any): boolean => {
        const ta = a ? new Date(a).getTime() : NaN;
        const tb = b ? new Date(b).getTime() : NaN;
        const aMissing = !a || Number.isNaN(ta);
        const bMissing = !b || Number.isNaN(tb);
        if (aMissing && bMissing) return true;
        if (aMissing !== bMissing) return false;
        return Math.abs(ta - tb) <= 1000;
      };
      // Strand recovery requires POSITIVE identity, not merely absence of
      // conflict (Step-7 round-3 latent LOW): require the period to be PRESENT
      // and equal on both sides, so a hypothetical future date-less provider
      // with a repeated identical amount + shared billingId can't false-match on
      // sameDate(absent,absent)=true. Every real (DEH) bill has a period, so a
      // genuine strand always satisfies this.
      const periodPresentAndEqual =
        !!billPayload.periodStart &&
        !!existing?.periodStart &&
        !!billPayload.periodEnd &&
        !!existing?.periodEnd &&
        sameDate(billPayload.periodStart, existing.periodStart) &&
        sameDate(billPayload.periodEnd, existing.periodEnd);
      const sameBill =
        existing &&
        itemBillingId &&
        String(existing.billingId) === String(itemBillingId) &&
        Number.isFinite(submittedTotal) &&
        Math.abs(Number(existing.totalAmount) - submittedTotal) <= 0.005 &&
        periodPresentAndEqual &&
        // The optional dates must also match any submitted amendment.
        sameDate(billPayload.issueDate, existing.issueDate) &&
        sameDate(billPayload.dueDate, existing.dueDate);
      if (sameBill) {
        await Collections.InboxItem.updateOne(
          { _id: id, realmId },
          { $set: { status: 'confirmed', updatedDate: new Date() } }
        );
        res.json(existing);
        return;
      }
    }
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
