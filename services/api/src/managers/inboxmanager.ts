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
import { Collections, Crypto, ServiceError } from '@microrealestate/common';
import type { ServiceRequest, ServiceResponse } from '@microrealestate/types';
import axios from 'axios';
import * as billStorage from './billstorage.js';
import { buildE9Preview } from './buildingmanager.js';
import { classifyAgainstExisting } from './pdfimportmanager.js';
import { confirmBills } from './billmanager.js';
import { findDuplicateBillByIdentity } from './billidentity.js';
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
  // 'processing' rows are INCLUDED. They are written at receipt, before the OCR finishes,
  // precisely so the bell can show that a file arrived and is being read — filtering them
  // out here would restore the old behaviour where the notification appeared only after a
  // parse that can take a minute, and pressing the bell mid-parse showed nothing new.
  const items = await Collections.InboxItem.find({
    realmId,
    status: { $in: ['processing', 'pending'] }
  })
    .sort({ createdDate: -1 })
    .lean();

  // BILL-IDENTITY (bill-OCR audit 2026-07): the Telegram lane needs the same
  // already-imported-under-a-different-term warning the upload dialog gets,
  // otherwise confirming from the bell silently inserts a second Bill for one
  // physical λογαριασμός and charges the tenants twice.
  //
  // Computed HERE at read time, not seeded onto the doc at ingest: an item can
  // be ingested BEFORE the other month's bill exists (so an ingest-time seed
  // would be permanently absent for exactly the sequence that causes the bug),
  // and a seeded warning also goes stale when the other bill is later replaced
  // or deleted. Read-time keeps it true whenever it is shown, and matches how
  // the upload lane computes it per parse.
  //
  // Only for items that already have a suggestedMatch — without a resolved
  // building+expense there is no scope to probe within.
  const withWarnings = await Promise.all(
    (items as any[]).map(async (item) => {
      // leaseImport/e9Import rows carry the FULL parser output in
      // importDoc.parsed — dozens of units for a real Ε9 — and the bell only
      // renders importDoc.summary. The dialog fetches the payload through
      // GET /inbox/:id/import-payload when opened; shipping it here would
      // resend it on every 60s refetch to a surface that never reads it.
      if (item?.importDoc) {
        item = {
          ...item,
          importDoc: { ...item.importDoc, parsed: undefined }
        };
      }
      const p = item?.parsed || {};
      const m = item?.suggestedMatch;
      if (!m?.buildingId || !m?.expenseId || !p.proposedTerm) return item;
      const duplicate = await findDuplicateBillByIdentity(
        realmId,
        String(m.buildingId),
        String(m.expenseId),
        p,
        Number(p.proposedTerm)
      );
      return duplicate ? { ...item, duplicate } : item;
    })
  );
  res.json(withWarnings);
}

/**
 * The view a voiceCommand sample row exposes to the settings card. A pure
 * mapper (exported for unit tests): the card renders WHO/WHAT/WHEN and the
 * outcome — deliberately NOT the transcript bodies (whatever the landlord said
 * to the bot stays out of the browser payload) and NOT the decodes (raw
 * calibration scores are analysis data, not UI data).
 */
export function _voiceSampleView(rows: any[]): any[] {
  return (rows || []).map((r) => {
    const vc = r?.voiceCommand || {};
    return {
      _id: r._id,
      createdDate: r.createdDate,
      intent: vc.intent || null,
      personName: vc.personName || null,
      amount: typeof vc.amount === 'number' ? vc.amount : null,
      month: typeof vc.month === 'number' ? vc.month : null,
      corrections: typeof vc.corrections === 'number' ? vc.corrections : 0,
      outcome: vc.outcome || null,
      // 🎤 vs ⌨️ on the card: the modality of the FIRST message of the dialogue.
      firstSource: vc.transcript?.[0]?.source || null
    };
  });
}

/**
 * GET /inbox/voicesamples — the shadow-mode validation samples, read-only,
 * newest first, capped to the latest 20 for the settings card. `stats` covers
 * ALL samples (countDocuments — which CASTS realmId like find(); an aggregate
 * $match would compare the ObjectId against the schema's String and silently
 * return zeros), so the summary line never lies when history exceeds the cap.
 */
export async function listVoiceSamples(req: Req, res: Res): Promise<void> {
  const realmId = req.realm?._id;
  if (!realmId) {
    throw new ServiceError('Unauthorized', 401);
  }
  const base = { realmId, kind: 'voiceCommand' } as const;
  const [rows, total, validated, rejected, abandoned, validatedLe1] =
    await Promise.all([
      Collections.InboxItem.find(base)
        .sort({ createdDate: -1 })
        .limit(20)
        .select('createdDate voiceCommand')
        .lean(),
      Collections.InboxItem.countDocuments(base),
      Collections.InboxItem.countDocuments({
        ...base,
        'voiceCommand.outcome': 'validated'
      }),
      Collections.InboxItem.countDocuments({
        ...base,
        'voiceCommand.outcome': 'rejected'
      }),
      Collections.InboxItem.countDocuments({
        ...base,
        'voiceCommand.outcome': 'abandoned'
      }),
      Collections.InboxItem.countDocuments({
        ...base,
        'voiceCommand.outcome': 'validated',
        'voiceCommand.corrections': { $lte: 1 }
      })
    ]);
  res.json({
    items: _voiceSampleView(rows as any[]),
    stats: { total, validated, rejected, abandoned, validatedLe1 }
  });
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
    // Distinguish «still being read» from «gone». The lookup above requires
    // status:'pending', so a processing row lands here — and «δεν βρέθηκε» would be a lie
    // about a row the landlord can see on their own screen.
    const processing = await Collections.InboxItem.exists({
      _id: id,
      realmId,
      status: 'processing'
    });
    if (processing) {
      throw new ServiceError(
        'Ο λογαριασμός διαβάζεται ακόμα — δοκιμάστε σε λίγο.',
        409
      );
    }
    throw new ServiceError('Το στοιχείο εισερχομένων δεν βρέθηκε', 404);
  }
  // kind:'notice' items carry no parsed bill — running them through the
  // confirmBills pipeline would insert a garbage Bill. Dismiss is the only
  // write a notice accepts.
  if (item.kind === 'notice') {
    throw new ServiceError(
      'Μια ειδοποίηση δεν μπορεί να καταχωρηθεί ως λογαριασμός', 422
    );
  }
  // kind:'leaseImport'/'e9Import' — confirm CONSUMES the notification, nothing
  // more. The actual import already ran through the dialog's own endpoints
  // (tenants/import via ImportTenantDialog, buildings/import-pdf?confirmed via
  // ImportE9Dialog) with all their guards; the page calls this afterwards so
  // the bell clears. Running these through confirmBills would insert a garbage
  // Bill from an empty `parsed` — the same shape the notice guard blocks.
  if (item.kind === 'leaseImport' || item.kind === 'e9Import') {
    await Collections.InboxItem.updateOne(
      { _id: id, realmId, status: 'pending' },
      { $set: { status: 'confirmed', updatedDate: new Date() } }
    );
    res.json({ ok: true });
    return;
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
    // What tenants may be charged (ΜΕΡΙΚΟ ΣΥΝΟΛΟ). Forwarded so confirming from the
    // bell splits this period's charges rather than ΠΛΗΡΩΤΕΟ, which on a bill carrying
    // a prior balance distributed the landlord's arrears across the tenants.
    //
    // Dropped when the operator AMENDS the amount: their figure is then their answer to
    // both questions, and keeping a parse-derived second figure alongside it would
    // silently disagree with what they typed.
    chargeableAmount:
      totalAmount !== undefined ? undefined : p.chargeableAmount,
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
    // A 'processing' row is dismissible too: it is the one state the landlord may want to
    // cancel out of (a mis-sent file, a parse taking too long). The scanner's finishing
    // update is conditional on status still being 'processing', so this wins the race.
    { _id: id, realmId, status: { $in: ['processing', 'pending'] } },
    { $set: { status: 'dismissed', updatedDate: new Date() } }
  );
  if (!updated.matchedCount) {
    throw new ServiceError('Το στοιχείο εισερχομένων δεν βρέθηκε', 404);
  }
  res.json({ ok: true });
}

/**
 * GET /inbox/:id/import-payload — what the import dialog needs to open from a
 * bell item, rebuilt FRESH where freshness matters:
 *   · leaseImport → { kind, parsed, classification } — the stored parse plus a
 *     fresh classifyAgainstExisting verdict (tenants change between ingest and
 *     open; the ingest-time verdict on the card is advisory only).
 *   · e9Import    → { kind, parsed, preview } — the stored parse plus the SAME
 *     existing-building/ΑΤΑΚ-matched preview the upload route builds, via the
 *     shared buildE9Preview.
 * Pending only: a consumed or dismissed item must not reopen a dialog.
 */
export async function getImportPayload(req: Req, res: Res): Promise<void> {
  const realmId = req.realm?._id;
  if (!realmId) {
    throw new ServiceError('Unauthorized', 401);
  }
  const { id } = req.params;
  validateObjectId(id, 'inbox item id');

  const item: any = await Collections.InboxItem.findOne({
    _id: id,
    realmId,
    status: 'pending',
    kind: { $in: ['leaseImport', 'e9Import'] }
  }).lean();
  if (!item?.importDoc?.parsed) {
    throw new ServiceError('Το στοιχείο εισερχομένων δεν βρέθηκε', 404);
  }

  if (item.kind === 'leaseImport') {
    let classification: unknown = { kind: 'new', matchedTenantId: null };
    try {
      classification = await classifyAgainstExisting(
        item.importDoc.parsed,
        String(realmId)
      );
    } catch {
      // Advisory, same contract as the upload route: a classification hiccup
      // must not block opening the dialog.
    }
    res.json({
      kind: item.kind,
      sourceFileName: item.sourceFileName || null,
      parsed: item.importDoc.parsed,
      classification
    });
    return;
  }

  res.json({
    kind: item.kind,
    sourceFileName: item.sourceFileName || null,
    parsed: item.importDoc.parsed,
    preview: await buildE9Preview(item.importDoc.parsed, String(realmId))
  });
}

/**
 * GET /inbox/:id/original — the source PDF bytes, for the dialogs' confirm
 * steps (the lease dialog persists the original to the tenant's documents; the
 * Ε9 dialog re-uploads it to import). Two sources, tried in order:
 *   1. the B2 archive key written at ingest (sourcePdfUrl);
 *   2. re-download from Telegram by telegramFileId — file_id does not expire
 *      (the stall-sweep comment in the scanner documents this), so the original
 *      stays reachable even when B2 is not configured.
 */
export async function getOriginal(req: Req, res: Res): Promise<void> {
  const realmId = req.realm?._id;
  if (!realmId) {
    throw new ServiceError('Unauthorized', 401);
  }
  const { id } = req.params;
  validateObjectId(id, 'inbox item id');

  const item: any = await Collections.InboxItem.findOne({
    _id: id,
    realmId
  }).lean();
  if (!item) {
    throw new ServiceError('Το στοιχείο εισερχομένων δεν βρέθηκε', 404);
  }

  let buffer: Buffer | null = null;
  if (item.sourcePdfUrl) {
    const realm: any = await Collections.Realm.findOne({ _id: realmId }).lean();
    const b2 = realm?.thirdParties?.b2;
    if (billStorage.isEnabled(b2)) {
      buffer = await billStorage.downloadBuffer(b2, item.sourcePdfUrl);
    }
  }
  if (!buffer && item.telegramFileId) {
    buffer = await _downloadTelegramFile(
      String(realmId),
      String(item.telegramFileId)
    );
  }
  if (!buffer) {
    throw new ServiceError('Το αρχικό αρχείο δεν είναι διαθέσιμο', 404);
  }

  const name = item.sourceFileName || 'document.pdf';
  res.setHeader(
    'Content-Type',
    /\.pdf$/i.test(name) ? 'application/pdf' : 'application/octet-stream'
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
  );
  res.send(buffer);
}

/** Telegram getFile → download, with the realm's own bot token. */
async function _downloadTelegramFile(
  realmId: string,
  fileId: string
): Promise<Buffer | null> {
  try {
    const realm: any = await Collections.Realm.findOne({ _id: realmId }).lean();
    const tg = realm?.thirdParties?.telegram;
    if (!tg?.botToken) return null;
    const botToken = Crypto.decrypt(tg.botToken);
    const info = await axios.get(
      `https://api.telegram.org/bot${botToken}/getFile`,
      { params: { file_id: fileId }, timeout: 15_000 }
    );
    const filePath = info.data?.result?.file_path;
    if (!filePath) return null;
    const file = await axios.get(
      `https://api.telegram.org/file/bot${botToken}/${filePath}`,
      { responseType: 'arraybuffer', timeout: 30_000 }
    );
    return Buffer.from(file.data);
  } catch (err: any) {
    // A 404 here is the honest outcome — the caller translates it.
    return null;
  }
}
