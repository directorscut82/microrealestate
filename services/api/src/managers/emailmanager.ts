import {
  Collections,
  logger,
  OwnerStatement,
  Service,
  ServiceError
} from '@microrealestate/common';
import type { ServiceRequest, ServiceResponse } from '@microrealestate/types';
import axios from 'axios';
import moment from 'moment';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = ServiceRequest<any, any, any>;
type Res = ServiceResponse;
type AnyRecord = Record<string, any>;

async function _sendEmail(req: Req, message: AnyRecord): Promise<AnyRecord[]> {
  const { EMAILER_URL } = Service.getInstance().envConfig.getValues();
  const postData = {
    templateName: message.document,
    recordId: message.tenantId,
    params: {
      term: message.term
    }
  };

  try {
    const response = await axios.post(EMAILER_URL as string, postData, {
      headers: {
        authorization: req.headers.authorization,
        organizationid: req.headers.organizationid || String(req.realm!._id),
        'Accept-Language': req.headers['accept-language']
      }
    });

    logger.debug(`data sent: ${JSON.stringify(postData)}`);
    logger.debug(`response: ${JSON.stringify(response.data)}`);

    // X1 (audit-2026-07): the emailer responds 200 with a PER-RECIPIENT
    // embedded failure ({status:{id:null,error}}) when the provider rejects
    // (Promise.allSettled). Surface it as a real `error` so callers/UI can't
    // report a bounced notice/invoice as delivered.
    return response.data.map(
      ({ templateName, recordId, params, email, status }: AnyRecord) => ({
        document: templateName,
        tenantId: recordId,
        term: params.term,
        email,
        status,
        ...(status && status.error
          ? { error: { status: 500, message: String(status.error) } }
          : {})
      })
    );
  } catch (error: any) {
    const errorMessage = error.response?.data?.message || error.message;
    logger.error(`POST ${EMAILER_URL} failed`);
    logger.error(`data sent: ${JSON.stringify(postData)}`);
    logger.error(errorMessage);
    // Propagate upstream client errors (4xx) verbatim so the landlord API
    // returns the same status as the emailer (e.g. 422 "missing recipients"
    // for tenants with no contacts) instead of swallowing everything as 500.
    const upstream = error?.response?.status;
    if (Number.isFinite(upstream) && upstream >= 400 && upstream < 500) {
      throw new ServiceError(errorMessage, upstream);
    }
    throw new ServiceError(`Email send failed: ${errorMessage}`, 500);
  }
}

async function _sendSms(
  req: Req,
  tenant: AnyRecord,
  document: string,
  term: number
): Promise<AnyRecord | null> {
  const { EMAILER_URL } = Service.getInstance().envConfig.getValues();
  const phones: string[] = [
    ...(tenant.phone ? [tenant.phone] : []),
    ...(tenant.contacts || []).flatMap((c: AnyRecord) => [c.phone1, c.phone2])
  ].filter(Boolean);
  // deduplicate
  const uniquePhones = [...new Set(phones)];
  if (!uniquePhones.length) {
    return null;
  }

  const termDate = moment.utc(String(term), 'YYYYMMDDHH');
  const monthYear = termDate.format('MM/YYYY');

  // Build an amount breakdown from the tenant's rent for this term.
  const rentRecord = (tenant.rents || []).find(
    (r: AnyRecord) => Number(r.term) === Number(term)
  );
  const grandTotal = rentRecord?.total?.grandTotal ?? 0;
  const fmt = (n: number) =>
    n.toLocaleString('el-GR', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + '€';

  let amountPart = '';
  if (rentRecord) {
    const parts: string[] = [];
    const rentAmount = rentRecord.total?.preTaxAmount ?? 0;
    const buildingCharges = (rentRecord.buildingCharges || []) as AnyRecord[];
    const repairs = buildingCharges.filter((c: AnyRecord) => c.type === 'repair');
    const koinoxrhsta = buildingCharges.filter((c: AnyRecord) => c.type !== 'repair');
    const koinoSum = koinoxrhsta.reduce((s: number, c: AnyRecord) => s + (c.amount || 0), 0);
    const repairSum = repairs.reduce((s: number, c: AnyRecord) => s + (c.amount || 0), 0);
    const balance = rentRecord.total?.balance ?? 0;

    if (rentAmount) parts.push(`Ενοίκιο: ${fmt(rentAmount)}`);
    if (koinoSum) parts.push(`Κοινόχρ: ${fmt(koinoSum)}`);
    if (repairSum) parts.push(`Επισκευή: ${fmt(repairSum)}`);
    if (balance > 0) parts.push(`Υπόλοιπο: ${fmt(balance)}`);

    // N4 (audit-2026-07): grandTotal = preTaxAmount + charges + buildingCharges
    // + debts − discount + vat + balance (businesslogic 7_total). The parts
    // above only cover rent + building charges + balance, so a VAT tenant (or
    // one with property charges/debts/discounts) had parts that didn't sum to
    // the printed ΣΥΝΟΛΟ. Fold everything not itemised above into one «Άλλα»
    // remainder computed as (grandTotal − shown parts) so the breakdown always
    // reconciles to the total, whatever the tax/charge mix.
    const shownSum = rentAmount + koinoSum + repairSum + (balance > 0 ? balance : 0);
    const other = Math.round((grandTotal - shownSum) * 100) / 100;
    if (Math.abs(other) > 0.005) parts.push(`Άλλα: ${fmt(other)}`);

    if (parts.length > 1) {
      amountPart = ` (${parts.join(', ')}, ΣΥΝΟΛΟ: ${fmt(grandTotal)})`;
    } else {
      amountPart = ` (${fmt(grandTotal)})`;
    }
  }

  const textMap: Record<string, string> = {
    rentcall: `Ειδοποίηση πληρωμής ${monthYear} - ${tenant.name}${amountPart}`,
    invoice: `Απόδειξη πληρωμής ${monthYear} - ${tenant.name}`
  };
  const text = textMap[document] || `Ειδοποίηση πληρωμής ${monthYear} - ${tenant.name}${amountPart}`;

  const results = await Promise.all(
    uniquePhones.map(async (phone) => {
      try {
        const response = await axios.post(
          `${EMAILER_URL}/sms`,
          { phoneNumber: phone, text },
          {
            headers: {
              authorization: req.headers.authorization,
              organizationid: req.headers.organizationid || String(req.realm!._id),
              'Accept-Language': req.headers['accept-language']
            }
          }
        );
        // PII: don't log tenant.name or phone in plaintext. Tenant id is
        // enough to correlate the audit trail without leaking PII into
        // log-aggregation systems.
        logger.info(`SMS sent (tenant ${tenant._id})`);
        return { phone, status: response.data };
      } catch (error: any) {
        logger.error(
          `SMS failed (tenant ${tenant._id}): ${error.message}`
        );
        return { phone, error: error.message };
      }
    })
  );
  return { smsResults: results };
}

export async function sendSmsOnly(req: Req, res: Res) {
  const realm = req.realm;
  const { tenantIds, terms, year, month, document } = req.body;
  if (!tenantIds?.length) {
    throw new ServiceError('tenantIds required', 422);
  }
  const defaultTerm = moment.utc(`${year}/${month}/01`, 'YYYY/MM/DD').format(
    'YYYYMMDDHH'
  );

  const tenants: AnyRecord[] = await Collections.Tenant.find({
    _id: { $in: tenantIds },
    realmId: realm!._id
  }).lean();

  // Round-1 audit M11: pair each tenant with its OWN term by id, not by the
  // (unordered) $in result position.
  const _termById = new Map(
    (tenantIds || []).map((id: any, i: number) => [
      String(id),
      terms && terms[i]
    ])
  );

  const statusList: AnyRecord[] = await Promise.all(
    tenants.map(async (tenant: AnyRecord) => {
      const term = Number(_termById.get(String(tenant._id)) ?? defaultTerm);
      const result = await _sendSms(req, tenant, document || 'rentcall', term);
      return {
        name: tenant.name,
        tenantId: String(tenant._id),
        term,
        ...(result || { error: 'No phone number found' })
      };
    })
  );

  if (statusList.some((s) => s.error || s.smsResults?.some((r: AnyRecord) => r.error))) {
    res.status(207).json(statusList);
  } else {
    res.json(statusList);
  }

  // Telegram admin echo — forward the SMS text content
  const smsSent = statusList.filter(
    (s) => s.smsResults && s.smsResults.some((r: AnyRecord) => !r.error)
  );
  if (smsSent.length) {
    const termDate = moment.utc(String(smsSent[0].term), 'YYYYMMDDHH');
    const lines = smsSent.map((s: AnyRecord) => {
      const rent = (
        (s as any)._rentRecord || (tenants.find((t: AnyRecord) => String(t._id) === s.tenantId) as any)?.rents?.find((r: AnyRecord) => Number(r.term) === s.term)
      );
      const gt = rent?.total?.grandTotal ?? '';
      return `${s.name}${gt ? ' (' + gt + '€)' : ''}`;
    });
    _echoToTelegram(req, `📱 SMS ${termDate.format('MM/YYYY')} → ${lines.join(', ')}`);
  }
}

// POST /emails/owners — batch-send owner expense statements (email with the
// owner-statement PDF attached). Body: { ownerKeys: string[], term: string }.
// Reuses the whole tenant-send skeleton: same emailer proxy, same 60-min
// dedupe (Email.recordId stores the ownerKey), same 200/207/500 shape, same
// Telegram admin echo with the PDF attached.
export async function sendOwnerStatements(req: Req, res: Res) {
  const realm = req.realm;
  const { ownerKeys, term, force } = req.body;
  // Two documents, mirroring the tenant popover: «Ειδοποίηση πληρωμής»
  // (owner_rentcall) and «Εκκαθαριστικό» (owner_statement). Same PDF
  // attachment (the owner statement IS the owner's document); the email
  // wording differs (due-date + payment methods vs neutral statement).
  const document =
    req.body.document === 'owner_rentcall' ? 'owner_rentcall' : 'owner_statement';
  if (!Array.isArray(ownerKeys) || !ownerKeys.length) {
    throw new ServiceError('ownerKeys required', 422);
  }
  if (!term || !/^(\d{4}(\d{6})?)(,\d{4}(\d{6})?){0,11}$/.test(String(term))) {
    throw new ServiceError('term must be YYYY or YYYYMMDDHH (comma list)', 422);
  }
  const { EMAILER_URL } = Service.getInstance().envConfig.getValues();

  // 60-minute double-send guard, keyed (ownerKey, owner_statement, term).
  const recentlySent = new Set<string>();
  if (!force) {
    const sixtyMinAgo = moment.utc().subtract(60, 'minutes').toDate();
    const sent: AnyRecord[] = await Collections.Email.find({
      realmId: String(realm!._id),
      recordId: { $in: ownerKeys },
      templateName: document,
      sentDate: { $gte: sixtyMinAgo },
      // X1: FAILED sends must not dedupe-block the retry — only rows that
      // actually went out count as "recently sent".
      status: { $ne: 'failed' }
    }).lean();
    for (const r of sent) {
      recentlySent.add(`${String(r.recordId)}|${String(r.params?.term)}`);
    }
  }

  const statusList: AnyRecord[] = await Promise.all(
    (ownerKeys as string[]).map(async (ownerKey) => {
      if (recentlySent.has(`${ownerKey}|${term}`)) {
        return { ownerKey, skipped: true, reason: 'recently sent' };
      }
      try {
        const response = await axios.post(
          EMAILER_URL as string,
          {
            templateName: document,
            recordId: ownerKey,
            params: { term: String(term) }
          },
          {
            headers: {
              authorization: req.headers.authorization,
              organizationid:
                req.headers.organizationid || String(req.realm!._id),
              'Accept-Language': req.headers['accept-language']
            }
          }
        );
        // X1: the emailer 200s even when the provider rejected a recipient —
        // the failure is EMBEDDED per-recipient as status:{id:null,error}.
        // Detect it so a bounced statement is never reported as sent.
        const rows: AnyRecord[] = Array.isArray(response.data)
          ? response.data
          : [];
        const embeddedError = rows.find(
          (r: AnyRecord) => r?.status?.error || (r?.status && r.status.id === null)
        );
        if (embeddedError) {
          const msg = String(
            embeddedError.status?.error || 'delivery failed'
          );
          logger.error(`owner statement send failed (${ownerKey}): ${msg}`);
          return { ownerKey, error: msg };
        }
        return { ownerKey, status: response.data };
      } catch (error: any) {
        const msg = error.response?.data?.message || error.message;
        logger.error(`owner statement send failed (${ownerKey}): ${msg}`);
        return { ownerKey, error: msg };
      }
    })
  );

  const hasError = statusList.some((s) => !!s.error);
  const allFailed =
    statusList.length > 0 && statusList.every((s) => !!s.error || s.skipped);
  if (allFailed && hasError) {
    res.status(500).json(statusList);
  } else if (hasError) {
    res.status(207).json(statusList);
  } else {
    res.json(statusList);
  }

  // Telegram admin echo with the SAME owner-statement PDF attached.
  const echoLabel =
    document === 'owner_rentcall' ? 'Ειδοποίηση πληρωμής ιδιοκτήτη' : 'Εκκαθαριστικό ιδιοκτήτη';
  for (const s of statusList) {
    if (s.error || s.skipped) continue;
    _echoToTelegram(req, `📧 ${echoLabel} → ${s.ownerKey}`, {
      templateName: 'owner-statement',
      recordId: String(s.ownerKey),
      term: String(term)
    });
  }
}

// POST /emails/owners/sms — SMS the owner their statement summary. Body:
// { ownerKeys: string[], term: string }. Text mirrors the tenant SMS format:
// «Εκκαθαριστικό MM/YYYY - name (Κοινόχρηστα: X, Επισκευές: Y, ΣΥΝΟΛΟ: Z)».
export async function sendOwnerSms(req: Req, res: Res) {
  const realm = req.realm;
  const { ownerKeys, term } = req.body;
  if (!Array.isArray(ownerKeys) || !ownerKeys.length) {
    throw new ServiceError('ownerKeys required', 422);
  }
  if (!term || !/^(\d{4}(\d{6})?)(,\d{4}(\d{6})?){0,11}$/.test(String(term))) {
    throw new ServiceError('term must be YYYY or YYYYMMDDHH (comma list)', 422);
  }
  const { EMAILER_URL } = Service.getInstance().envConfig.getValues();

  const buildings: AnyRecord[] = await Collections.Building.find({
    realmId: String(realm!._id)
  }).lean();

  // O2: the SMS total must apply the SAME occupancy staleness guard the email
  // + PDF builders use, or a vacant/owner-resident row for a term a tenant now
  // occupies double-counts the tenant's rent into the owner's SMS ΣΥΝΟΛΟ.
  const unitPropIds: string[] = [];
  for (const b of buildings) {
    for (const u of b.units || []) {
      if (u.propertyId) unitPropIds.push(String(u.propertyId));
    }
  }
  const occTenants: AnyRecord[] = unitPropIds.length
    ? await Collections.Tenant.find(
        { realmId: String(realm!._id), 'properties.propertyId': { $in: unitPropIds } },
        {
          beginDate: 1,
          endDate: 1,
          terminationDate: 1,
          'properties.propertyId': 1,
          'properties.entryDate': 1,
          'properties.exitDate': 1
        }
      ).lean()
    : [];

  const fmt = (n: number) =>
    n.toLocaleString('el-GR', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    }) + '€';
  const termLabel = /^\d{4}$/.test(String(term))
    ? String(term)
    : moment.utc(String(term).split(',')[0], 'YYYYMMDDHH').format('MM/YYYY');

  const statusList: AnyRecord[] = await Promise.all(
    (ownerKeys as string[]).map(async (ownerKey) => {
      try {
        if (OwnerStatement.isLoipoiKey(ownerKey)) {
          return { ownerKey, error: 'placeholder owner cannot be notified' };
        }
        // Expand year-prefix terms exactly like the statement builders do.
        const all = OwnerStatement.buildOwnerStatement(buildings, ownerKey, []);
        const subTerms = String(term).split(',').filter(Boolean);
        const allTerms = [
          ...new Set(all.charges.map((c: AnyRecord) => c.term))
        ];
        const terms = allTerms.filter((t: any) =>
          subTerms.some((st) => String(t).startsWith(st))
        );
        const occupiedKeys = OwnerStatement.occupiedPropertyTermKeys(
          occTenants,
          terms as number[]
        );
        const statement = OwnerStatement.buildOwnerStatement(
          buildings,
          ownerKey,
          terms as number[],
          occupiedKeys,
          // O1: specific term filtered to zero → empty, not all-history.
          subTerms.length ? 'none' : 'all'
        );
        if (!statement.owner) {
          return { ownerKey, error: 'owner not found' };
        }
        // O1: don't SMS a total for a period the owner has no charges in.
        if (subTerms.length && statement.charges.length === 0) {
          return { ownerKey, error: 'no charges for the requested period' };
        }
        const phone = String(statement.owner.phone || '').trim();
        if (!phone) {
          return { ownerKey, error: 'no phone number' };
        }
        const repairs = statement.charges.filter(
          (c: AnyRecord) => c.source === 'repair' || c.source === 'repair-vacant'
        );
        const repairSum = repairs.reduce(
          (s: number, c: AnyRecord) => s + (Number(c.amount) || 0),
          0
        );
        const koinoSum = (Number(statement.totals.amount) || 0) - repairSum;
        const outstanding = Number(statement.totals.outstanding) || 0;
        const grossAmount = Number(statement.totals.amount) || 0;
        // Κοινόχρηστα + Επισκευές already sum to the gross ΣΥΝΟΛΟ (koinoSum is
        // defined as totals.amount − repairSum), so these two are the summing
        // parts.
        const parts: string[] = [];
        if (koinoSum > 0.005) parts.push(`Κοινόχρηστα: ${fmt(koinoSum)}`);
        if (repairSum > 0.005) parts.push(`Επισκευές: ${fmt(repairSum)}`);
        const breakdown =
          parts.length > 1
            ? ` (${parts.join(', ')}, ΣΥΝΟΛΟ: ${fmt(grossAmount)})`
            : ` (${fmt(grossAmount)})`;
        // O9 (audit-2026-07): a payment notice must show what is still OWED.
        // Outstanding is a DIFFERENT basis than the gross parts above (it nets
        // out prior payments), so it must NOT sit inside the summing
        // parenthetical — that read as if it should add to the total. When the
        // owner has already part-paid, append it as a separate, clearly-labelled
        // clause AFTER the gross breakdown so a partially-paid owner isn't
        // dunned for the full amount while their emailed statement shows the
        // smaller balance.
        const owedClause =
          outstanding > 0.005 && outstanding < grossAmount - 0.005
            ? ` — Οφειλόμενο υπόλοιπο: ${fmt(outstanding)}`
            : '';
        const text = `Ειδοποίηση πληρωμής ${termLabel} - ${statement.owner.name}${breakdown}${owedClause}`;

        const response = await axios.post(
          `${EMAILER_URL}/sms`,
          { phoneNumber: phone, text },
          {
            headers: {
              authorization: req.headers.authorization,
              organizationid:
                req.headers.organizationid || String(req.realm!._id),
              'Accept-Language': req.headers['accept-language']
            }
          }
        );
        logger.info(`owner SMS sent (${ownerKey})`);
        return { ownerKey, name: statement.owner.name, status: response.data };
      } catch (error: any) {
        const msg = error.response?.data?.message || error.message;
        logger.error(`owner SMS failed (${ownerKey}): ${msg}`);
        return { ownerKey, error: msg };
      }
    })
  );

  const hasError = statusList.some((s) => !!s.error);
  if (hasError) {
    res.status(207).json(statusList);
  } else {
    res.json(statusList);
  }

  const sent = statusList.filter((s) => !s.error);
  if (sent.length) {
    const names = sent.map((s: AnyRecord) => s.name || s.ownerKey).join(', ');
    _echoToTelegram(req, `📱 SMS ${termLabel} → ${names}`);
  }
}

// Send a Telegram notification for the current realm. With no chatId the
// emailer falls back to the realm's configured adminChatId (admin/self
// notifications — "ping me about stuff"). Proxies to the emailer, which
// holds the (encrypted) bot token, mirroring _sendSms.
export async function sendTelegramNotification(req: Req, res: Res) {
  const { text, chatId } = req.body;
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new ServiceError('text is required', 422);
  }
  const { EMAILER_URL } = Service.getInstance().envConfig.getValues();
  try {
    const response = await axios.post(
      `${EMAILER_URL}/telegram`,
      { text, ...(chatId ? { chatId } : {}) },
      {
        headers: {
          authorization: req.headers.authorization,
          organizationid:
            req.headers.organizationid || String(req.realm!._id),
          'Accept-Language': req.headers['accept-language']
        }
      }
    );
    logger.info('Telegram notification sent');
    res.json(response.data);
  } catch (error: any) {
    const errorMessage = error.response?.data?.message || error.message;
    const upstream = error?.response?.status;
    if (Number.isFinite(upstream) && upstream >= 400 && upstream < 500) {
      throw new ServiceError(errorMessage, upstream);
    }
    throw new ServiceError(`Telegram send failed: ${errorMessage}`, 500);
  }
}

// Fire-and-forget Telegram echo to the admin (best-effort, never blocks the
// primary send response). Called after email/SMS batches so the landlord sees
// a summary in their bot chat without refreshing the app. Optional
// `attachment` ({templateName, recordId, term}) makes the emailer fetch the
// same rendered PDF the email attaches and deliver it as a Telegram document.
function _echoToTelegram(
  req: Req,
  text: string,
  attachment?: { templateName: string; recordId: string; term: number | string }
) {
  const { EMAILER_URL } = Service.getInstance().envConfig.getValues();
  axios
    .post(
      `${EMAILER_URL}/telegram`,
      { text, ...(attachment ? { attachment } : {}) },
      {
        headers: {
          authorization: req.headers.authorization,
          organizationid:
            req.headers.organizationid || String(req.realm!._id),
          'Accept-Language': req.headers['accept-language']
        }
      }
    )
    .catch((err: any) => {
      logger.warn(`Telegram echo failed (non-blocking): ${err.message}`);
    });
}

export async function send(req: Req, res: Res) {
  const realm = req.realm;
  const { document, tenantIds, terms, year, month, force } = req.body;
  const defaultTerm = moment.utc(`${year}/${month}/01`, 'YYYY/MM/DD').format(
    'YYYYMMDDHH'
  );

  const tenants: AnyRecord[] = await Collections.Tenant.find({
    _id: { $in: tenantIds },
    realmId: realm!._id
  }).lean();

  // Round-1 audit M11: a `$in` query does NOT preserve the request's tenantId
  // order, so reading terms[index] by RESULT position pairs a tenant with
  // ANOTHER tenant's term in a heterogeneous bulk send. Map each request
  // tenantId → its own term once, then look up by the tenant's _id.
  const _termById = new Map(
    (tenantIds || []).map((id: any, i: number) => [
      String(id),
      terms && terms[i]
    ])
  );

  // Wave-24 A10: prevent accidental double-send. The Email collection tracks
  // every successfully-sent message; a 60-minute lookback for the same
  // (tenantId, templateName, term) is sufficient to catch double-clicks
  // and accidental re-submits without blocking legitimate retries
  // (a force=true flag bypasses the guard for the rare resend case).
  const recentlySentKeys = new Set<string>();
  if (!force) {
    const sixtyMinAgo = moment.utc().subtract(60, 'minutes').toDate();
    const sentRecords: AnyRecord[] = await Collections.Email.find({
      realmId: String(realm!._id),
      recordId: { $in: tenantIds },
      templateName: document,
      sentDate: { $gte: sixtyMinAgo },
      // X1 (audit-2026-07): a bounced send persists a status:'failed' Email
      // audit row. Without this filter that row dedupe-blocks the retry for
      // 60 minutes, so a bounced notice can never be resent (and the earlier
      // failure was itself reported as delivered). Only SUCCESSFUL sends
      // should suppress a resend. Mirrors the owner-statement dedupe.
      status: { $ne: 'failed' }
    })
      .lean();
    for (const r of sentRecords as AnyRecord[]) {
      const tk = String(r.recordId);
      const term = Number(r.params?.term);
      if (Number.isFinite(term)) {
        recentlySentKeys.add(`${tk}|${term}`);
      }
    }
  }

  const statusList = await Promise.all(
    tenants.map(async (tenant: AnyRecord) => {
      const tenantId = String(tenant._id);
      const term = Number(_termById.get(tenantId) ?? defaultTerm);

      // Wave-24 A10: skip + warn if the same (tenant, document, term) was
      // emailed within the last 60 minutes. Force=true bypasses.
      if (recentlySentKeys.has(`${tenantId}|${term}`)) {
        return {
          name: tenant.name,
          tenantId,
          document,
          term,
          skipped: true,
          reason:
            'Already sent within the last 60 minutes. Pass force=true to resend.'
        };
      }

      try {
        const emailStatus = await _sendEmail(req, {
          name: tenant.name,
          tenantId,
          document,
          term
        });
        // X1 (audit-2026-07): _sendEmail returns an ARRAY (one row per emailer
        // recipient). Spreading it into this object literal produces numeric
        // keys ({0:{…}}), so a per-recipient embedded error (the emailer's
        // 200-with-{status:{id:null,error}} bounce) would land at row['0'].error
        // — invisible to the batch classifier (hasError/allFailed) and the
        // Telegram echo below, which read row.error. A bounced notice would be
        // reported DELIVERED. Lift any embedded error to the TOP level so the
        // classifier sees it. (The spread is left intact to preserve the
        // existing per-tenant status shape the frontend already consumes.)
        const embeddedError = Array.isArray(emailStatus)
          ? emailStatus.find((e: AnyRecord) => e?.error)?.error
          : (emailStatus as AnyRecord)?.error;
        return {
          name: tenant.name,
          tenantId,
          document,
          term,
          ...emailStatus,
          ...(embeddedError ? { error: embeddedError } : {})
        };
      } catch (error: any) {
        logger.error(error);
        return {
          name: tenant.name,
          tenantId,
          document,
          term,
          error: error.response?.data || {
            status: 500,
            message: `Something went wrong when sending the email to ${tenant.name}`
          }
        };
      }
    })
  );

  // Mixed-success batch: some tenants delivered, others failed. HTTP
  // 500 for the whole batch was misleading — clients couldn't tell
  // whether ANY succeeded. RFC 4918 207 Multi-Status (or 200 with
  // per-item status when ALL succeeded) is the right shape: client
  // iterates statusList and acts on each. Mirrors the SMS path.
  const hasError = statusList.some((status) => !!status.error);
  const allFailed =
    statusList.length > 0 && statusList.every((status) => !!status.error);
  if (allFailed) {
    res.status(500).json(statusList);
  } else if (hasError) {
    res.status(207).json(statusList);
  } else {
    res.json(statusList);
  }

  // Telegram admin echo (fire-and-forget after response). Attach the same
  // rendered PDF the email carried — one echo per tenant so each PDF lands
  // in the admin chat exactly like it landed in the tenant's inbox.
  const sent = statusList.filter((s) => !s.error && !s.skipped);
  if (sent.length) {
    const label = req.body.document === 'invoice' ? 'Τιμολόγιο' : 'Ειδοποίηση πληρωμής';
    for (const s of sent as AnyRecord[]) {
      const termDate = moment.utc(String(s.term), 'YYYYMMDDHH');
      _echoToTelegram(
        req,
        `📧 ${label} ${termDate.format('MM/YYYY')} → ${s.name}`,
        {
          templateName: String(req.body.document || 'rentcall'),
          recordId: String(s.tenantId),
          term: s.term
        }
      );
    }
  }
  const failed = statusList.filter((s) => s.error);
  if (failed.length) {
    const names = failed.map((s: AnyRecord) => s.name).join(', ');
    _echoToTelegram(req, `❌ Email αποτυχία → ${names}`);
  }
}
