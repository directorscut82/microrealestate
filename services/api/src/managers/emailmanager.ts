import { Collections, logger, Service, ServiceError } from '@microrealestate/common';
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

    return response.data.map(
      ({ templateName, recordId, params, email, status }: AnyRecord) => ({
        document: templateName,
        tenantId: recordId,
        term: params.term,
        email,
        status
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
  const textMap: Record<string, string> = {
    rentcall: `Υπενθύμιση ενοικίου ${monthYear} - ${tenant.name}`,
    rentcall_reminder: `Υπενθύμιση: Εκκρεμεί ενοίκιο ${monthYear} - ${tenant.name}`,
    rentcall_last_reminder: `Τελευταία υπενθύμιση: Εκκρεμεί ενοίκιο ${monthYear} - ${tenant.name}`,
    invoice: `Απόδειξη ενοικίου ${monthYear} - ${tenant.name}`
  };
  const text = textMap[document] || `Ειδοποίηση ενοικίου ${monthYear}`;

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

  const statusList: AnyRecord[] = await Promise.all(
    tenants.map(async (tenant: AnyRecord, index: number) => {
      const term = Number((terms && terms[index]) || defaultTerm);
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
      sentDate: { $gte: sixtyMinAgo }
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
    tenants.map(async (tenant: AnyRecord, index: number) => {
      const tenantId = String(tenant._id);
      const term = Number((terms && terms[index]) || defaultTerm);

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
        return {
          name: tenant.name,
          tenantId,
          document,
          term,
          ...emailStatus
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
}
