import { Collections } from '@microrealestate/common';
import type { ServiceRequest, ServiceResponse } from '@microrealestate/types';
import i18n from 'i18n';
import moment from 'moment';
import { Parser } from 'json2csv';
import { validateYear } from '../validators.js';
import * as OwnerManager from './ownermanager.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = ServiceRequest<any, any, any>;
type Res = ServiceResponse;
type AnyRecord = Record<string, any>;

// Avoid floating-point drift on aggregated sums (e.g. 6624.399999999999).
// Round every aggregate result before returning to API consumers.
function _round(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Wave-26 round-3o (security): neutralise CSV formula injection in any
 * free-text field that ends up in the export. Excel/LibreOffice/Google
 * Sheets evaluate cells starting with =, +, -, @ as formulas, so a
 * tenant-provided note like `=SYSTEM("rm -rf")` would execute on the
 * accountant's machine. Prefixing with a single quote forces the cell
 * to render as text. Tab and carriage return are sanitised too because
 * some tools treat them as field separators.
 *
 * json2csv handles standard quote/newline escaping correctly; this
 * guard only addresses the formula-prefix vector json2csv ignores.
 */
function _sanitizeCsvText(s: string): string {
  if (!s) return s;
  // Strip any leading whitespace before the formula char so a
  // crafted "  =cmd|' /C calc'!A1" still gets caught.
  const leading = /^[\t\r\n ]*/;
  const trimmed = s.replace(leading, '');
  if (/^[=+\-@\t\r]/.test(trimmed)) {
    return `'${s}`;
  }
  return s;
}

async function _fetchData(realmId: string, year: number): Promise<AnyRecord[]> {
  return await Collections.Tenant.aggregate([
    {
      $match: {
        realmId,
        'rents.year': year
      }
    },
    {
      $addFields: {
        nameLowerCase: { $toLower: '$name' },
        properties: {
          $map: {
            input: '$properties',
            as: 'p',
            in: {
              _id: '$$p.property._id',
              type: '$$p.property.type',
              name: '$$p.property.name'
            }
          }
        },
        rents: {
          $map: {
            input: '$rents',
            as: 'rent',
            in: {
              year: '$$rent.year',
              month: '$$rent.month',
              payments: '$$rent.payments',
              total: '$$rent.total',
              // Wave-26 round-3k: surface the rent-level notes that the
              // accounting CSV/UI builder reads at line 281. Without
              // these in the projection, description/notepromo/
              // noteextracharge were silently undefined and the Notes
              // column was always empty.
              description: '$$rent.description',
              notepromo: '$$rent.notepromo',
              noteextracharge: '$$rent.noteextracharge',
              discounts: '$$rent.discounts',
              debts: '$$rent.debts'
            }
          }
        }
      }
    },
    {
      $addFields: {
        incoming: {
          $and: [
            { $gte: ['$beginDate', new Date(`${year}-01-01T00:00:00`)] },
            { $lt: ['$beginDate', new Date(`${year + 1}-01-01T00:00:00`)] }
          ]
        },
        // Wave-17 B6: "outgoing" means the tenant ACTUALLY left during the
        // year, i.e. terminationDate set and falling in [year]. A bare
        // endDate match is not a departure event — many active leases run
        // through year-end and renew automatically; including them here
        // pollutes the outgoing CSV with still-active tenants.
        outgoing: {
          $and: [
            { $ne: ['$terminationDate', null] },
            {
              $gte: ['$terminationDate', new Date(`${year}-01-01T00:00:00`)]
            },
            {
              $lt: [
                '$terminationDate',
                new Date(`${year + 1}-01-01T00:00:00`)
              ]
            }
          ]
        }
      }
    },
    {
      $sort: {
        nameLowerCase: 1
      }
    },
    {
      $project: {
        realmId: 1,
        _id: 1,
        name: 1,
        incoming: 1,
        outgoing: 1,
        reference: 1,
        beginDate: 1,
        endDate: 1,
        terminationDate: 1,
        guaranty: 1,
        guarantyPayback: 1,
        properties: 1,
        rents: {
          $filter: {
            input: '$rents',
            as: 'rent',
            cond: {
              $eq: ['$$rent.year', year]
            }
          }
        }
      }
    }
  ]);
}

function _properties(tenant: AnyRecord, rawData = true): AnyRecord[] | string {
  if (rawData) {
    return tenant.properties.map(({ _id, name, type }: AnyRecord) => ({
      _id,
      name,
      type
    }));
  }

  // Round-2 audit H8: property names are tenant/landlord-controlled; sanitize
  // each before joining for the CSV path (formula-prefix neutralization).
  return tenant.properties
    .map(({ name }: AnyRecord) => _sanitizeCsvText(name))
    .join('\n');
}

// Build a currency formatter for the CSV path (rawData=false) that NEVER
// throws: the JSON path (rawData=true, consumed by React) uses a passthrough,
// and an empty/invalid `currency` falls back to a passthrough instead of
// throwing a RangeError that would take down the whole Accounting page + CSV
// exports (round-2 audit H5). A realm with currency:'' (legacy/mongo-seed;
// realm schema has no default/required) is the trigger.
function _safeCurrencyFormatter(
  locale: string | undefined,
  currency: string | undefined,
  rawData: boolean
): { format: (value: number) => number } {
  // rawData (JSON for React) → identity passthrough returning the raw number,
  // exactly as the prior `{ format: (value) => value }` did. The CSV path gets
  // a real Intl formatter; a bad/empty currency falls back to the SAME identity
  // passthrough rather than throwing (round-2 audit H5). NOTE: the passthrough
  // returns the number unchanged (matching prior behavior); call sites that
  // need a string already coerce via template/translate.
  const passthrough = { format: (value: number) => value };
  if (rawData) return passthrough;
  try {
    // Intl.NumberFormat.format returns string; cast to the shared shape — CSV
    // cells accept both, and the prior code assigned the same union.
    return Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currency || 'EUR',
      minimumFractionDigits: 2
    }) as unknown as { format: (value: number) => number };
  } catch {
    return passthrough;
  }
}

function _incomingTenants(
  tenants: AnyRecord[],
  locale?: string,
  currency?: string,
  rawData = true
): AnyRecord[] {
  const NumberFormat = _safeCurrencyFormatter(locale, currency, rawData);

  return tenants
    .filter(({ incoming }: AnyRecord) => incoming)
    .map((tenant: AnyRecord) => {
      // Pin CSV dates to ISO (YYYY-MM-DD) so the same column doesn't
      // alternate between DD/MM/YYYY (fr/de/...) and MM/DD/YYYY (en) in
      // the same export. Raw API responses keep Date objects.
      const beginDate = rawData
        ? tenant.beginDate
        : moment.utc(tenant.beginDate).format('YYYY-MM-DD');
      // Wave-24 B15: tenant.endDate reflects the post-renewal end (incoming
      // year may show a date 30 years in the future). Without a separate
      // "original endDate" field on the schema we can't reconstruct the
      // contract's intended end on the date the tenant entered. Drop the
      // misleading endDate from the incoming CSV/JSON entirely. The
      // outgoing CSV (where endDate IS the tenant's actual departure)
      // keeps it.
      const terminationDate = rawData
        ? tenant.terminationDate
        : tenant.terminationDate
          ? moment.utc(tenant.terminationDate).format('YYYY-MM-DD')
          : '';

      return {
        _id: tenant._id,
        // Round-2 audit H8: sanitize tenant-controlled strings on the CSV
        // (rawData=false) path — json2csv escapes quotes/newlines but NOT a
        // leading formula prefix (=,+,-,@). The JSON path (React) is untouched.
        name: rawData ? tenant.name : _sanitizeCsvText(tenant.name),
        reference: rawData ? tenant.reference : _sanitizeCsvText(tenant.reference),
        properties: _properties(tenant, rawData),
        beginDate,
        terminationDate,
        guaranty: NumberFormat.format(_round(tenant.guaranty || 0))
      };
    });
}

function _outgoingTenants(
  tenants: AnyRecord[],
  locale?: string,
  currency?: string,
  rawData = true
): AnyRecord[] {
  const NumberFormat = _safeCurrencyFormatter(locale, currency, rawData);

  return tenants
    .filter(({ outgoing }: AnyRecord) => outgoing)
    .map((tenant: AnyRecord) => {
      // Pin CSV dates to ISO (YYYY-MM-DD) for consistency across locales
      // (see _incomingTenants). Raw API responses keep Date objects.
      const beginDate = rawData
        ? tenant.beginDate
        : moment.utc(tenant.beginDate).format('YYYY-MM-DD');
      const endDate = rawData
        ? tenant.endDate
        : moment.utc(tenant.endDate).format('YYYY-MM-DD');
      const terminationDate = rawData
        ? tenant.terminationDate
        : tenant.terminationDate
          ? moment.utc(tenant.terminationDate).format('YYYY-MM-DD')
          : '';
      const lastRent = tenant.rents?.length
        ? tenant.rents[tenant.rents.length - 1]
        : {
            total: { grandTotal: 0 }
          };

      // Round aggregated currency values to 2dp before formatting so we
      // never emit 6624.399999999999 in raw API responses or CSV exports.
      const balance = _round(
        (lastRent.total.payment ? lastRent.total.payment : 0) -
          lastRent.total.grandTotal
      );
      const finalBalance = _round(
        (lastRent.total.payment ? lastRent.total.payment : 0) +
          (tenant.guaranty ? tenant.guaranty : 0) -
          (tenant.guarantyPayback ? tenant.guarantyPayback : 0) -
          lastRent.total.grandTotal
      );

      return {
        _id: tenant._id,
        // Round-2 audit H8: sanitize on the CSV path (see _incomingTenants).
        name: rawData ? tenant.name : _sanitizeCsvText(tenant.name),
        reference: rawData ? tenant.reference : _sanitizeCsvText(tenant.reference),
        properties: _properties(tenant, rawData),
        beginDate,
        endDate,
        terminationDate,
        guaranty: NumberFormat.format(_round(tenant.guaranty || 0)),
        guarantyPayback: NumberFormat.format(_round(tenant.guarantyPayback || 0)),
        balance: NumberFormat.format(balance),
        finalBalance: NumberFormat.format(finalBalance)
      };
    });
}

function _settlements(
  tenants: AnyRecord[],
  locale: string,
  currency: string,
  rawData = true
): AnyRecord[] {
  // Gate construction on !rawData like the _incomingTenants/_outgoingTenants
  // siblings (the JSON path consumed by React never needs a formatter), AND
  // fall back to a passthrough if `currency` is empty/invalid — an unconditional
  // Intl.NumberFormat with currency:'' threw a RangeError that took down the
  // ENTIRE Accounting page + all 3 CSV exports (round-2 audit H5).
  const NumberFormat = _safeCurrencyFormatter(locale, currency, rawData);

  const months = moment.localeData(locale).months();

  return tenants.map((tenant: AnyRecord) => {
    // Pin CSV dates to ISO (YYYY-MM-DD); see _incomingTenants for rationale.
    // Guard the moment.utc against a missing date — moment.utc(undefined) is
    // TODAY (drifting daily), which fabricated a begin/end period for any
    // legacy/mongo-seed tenant lacking begin/termination/end (round-2 audit M5).
    // Mirrors the _incomingTenants/_outgoingTenants `value ? ... : ''` guard.
    const _endRaw = tenant.terminationDate || tenant.endDate;
    const beginDate = rawData
      ? tenant.beginDate
      : tenant.beginDate
        ? moment.utc(tenant.beginDate).format('YYYY-MM-DD')
        : '';
    const endDate = rawData
      ? _endRaw
      : _endRaw
        ? moment.utc(_endRaw).format('YYYY-MM-DD')
        : '';
    const settlements: AnyRecord = rawData
      ? (months as unknown as string[]).map(() => null)
      : (months as unknown as string[]).reduce((acc: AnyRecord, m: string) => {
          acc[m] = '';
          return acc;
        }, {});

    // Wave-26: parallel array of rent-level note fields per month. UI
    // consumes this to render a "Notes" surface alongside payments.
    // Indexed identically to settlements (0=Jan, 11=Dec). null means no rent
    // for that month or no notes.
    const notesByMonth: (AnyRecord | null)[] = (months as unknown as string[]).map(
      () => null
    );

    tenant.rents.forEach(({ month, payments, description, discounts, debts }: AnyRecord) => {
      if (rawData) {
        settlements[month - 1] = payments.map(
          ({ date, type, amount, reference }: AnyRecord) => ({
            // moment(date, 'DD/MM/YYYY') uses local TZ; for serialised
            // payment dates we always want UTC so a row exported from
            // CET and re-imported in UTC doesn't shift by a day.
            date: moment.utc(date, 'DD/MM/YYYY', true).toDate(),
            type,
            amount,
            reference
          })
        );
        // Wave-26 round-3k: aggregate notepromo from settlement discounts
        // and noteextracharge from debts. The rent doc itself doesn't
        // store these as top-level fields — frontdata.ts builds them on
        // serialise. We replicate the aggregation here so the Accounting
        // notes column reflects rent-level + per-payment context.
        const np = (discounts || [])
          .filter((d: AnyRecord) => d?.origin === 'settlement')
          .map((d: AnyRecord) => String(d?.description || '').trim())
          .filter(Boolean)
          .join('\n')
          .trim();
        const ne = (debts || [])
          .map((d: AnyRecord) => String(d?.description || '').trim())
          .filter(Boolean)
          .join('\n')
          .trim();
        const desc = (description || '').trim();
        if (desc || np || ne) {
          // Sanitise against CSV formula injection — these strings flow
          // into rawData JSON consumed by the Accounting UI and may be
          // exported to spreadsheet by downstream tooling. Cheap to
          // apply unconditionally; cosmetic effect is a leading single
          // quote on hostile input only.
          notesByMonth[month - 1] = {
            description: _sanitizeCsvText(desc),
            notepromo: _sanitizeCsvText(np),
            noteextracharge: _sanitizeCsvText(ne)
          };
        }
      } else {
        settlements[(months as unknown as string[])[month - 1]] = payments
          .map(({ date, type, amount, reference }: AnyRecord) => {
            // Pin CSV date format to ISO (YYYY-MM-DD). The input is stored
            // as DD/MM/YYYY; rendering with moment().format('L') would mix
            // DD/MM/YYYY and MM/DD/YYYY in the same row depending on the
            // realm locale, breaking downstream tooling that imports the CSV.
            const isoDate = moment
              .utc(date, 'DD/MM/YYYY', true)
              .format('YYYY-MM-DD');
            // Round-2 audit H8: payment reference is tenant-controlled and
            // lands in a CSV cell — neutralize a leading formula prefix.
            return `${isoDate} ${i18n.__(
              type
            )} ${_sanitizeCsvText(reference)}\n${NumberFormat.format(amount)}`;
          })
          .join('\n\n');
      }
    });

    return rawData
      ? {
          tenantId: tenant._id,
          tenant: tenant.name,
          beginDate,
          endDate,
          settlements,
          notesByMonth
        }
      : {
          tenantId: tenant._id,
          // Round-2 audit H8: the composite tenant cell interpolates
          // tenant-controlled name / reference / property names into a single
          // CSV cell. Sanitize each so a leading formula prefix (=,+,-,@) on the
          // cell — or on any embedded line — is neutralized.
          tenant: `${_sanitizeCsvText(tenant.name)}\n${_sanitizeCsvText(
            tenant.reference
          )}\n${beginDate} - ${endDate}\n${i18n.__('Deposit: {{deposit}}', {
            deposit: String(NumberFormat.format(_round(tenant.guaranty || 0)))
          })}\n${tenant.properties
            .map(({ name }: AnyRecord) => _sanitizeCsvText(name))
            .join('\n')}`,
          ...settlements
        };
  });
}

export async function all(req: Req, res: Res) {
  const realm = req.realm!;
  const year = req.params?.year
    ? validateYear(req.params.year, 'year')
    : new Date().getFullYear();

  const tenants = await _fetchData(String(realm._id), year);

  res.json({
    year,
    incomingTenants: _incomingTenants(tenants),
    outgoingTenants: _outgoingTenants(tenants),
    settlements: _settlements(tenants, realm.locale, realm.currency)
  });
}

async function incomingTenantsAsCsv(req: Req, res: Res) {
  const realm = req.realm!;
  const realmId = String(realm._id);
  const year = req.params?.year
    ? validateYear(req.params.year, 'year')
    : new Date().getFullYear();
  i18n.setLocale(realm.locale);

  const tenants = await _fetchData(realmId, year);
  const data = _incomingTenants(tenants, realm.locale, realm.currency, false);
  // Wave-24 B15: drop the misleading "Contract end date" column — see
  // _incomingTenants for the rationale.
  const fields = [
    { label: i18n.__('Name'), value: 'name' },
    { label: i18n.__('Reference'), value: 'reference' },
    { label: i18n.__('Properties'), value: 'properties' },
    { label: i18n.__('Contract begin date'), value: 'beginDate' },
    { label: i18n.__('Contract termination date'), value: 'terminationDate' },
    { label: i18n.__('Deposit'), value: 'guaranty' }
  ];
  const json2csv = new Parser({ fields, delimiter: ';', withBOM: true });
  const csv = json2csv.parse(data);
  res.header('Content-Type', 'text/csv');
  return res.send(csv);
}

async function outgoingTenantsAsCsv(req: Req, res: Res) {
  const realm = req.realm!;
  const realmId = String(realm._id);
  const year = req.params?.year
    ? validateYear(req.params.year, 'year')
    : new Date().getFullYear();

  i18n.setLocale(realm.locale);

  const tenants = await _fetchData(realmId, year);
  const data = _outgoingTenants(tenants, realm.locale, realm.currency, false);
  const fields = [
    { label: i18n.__('Name'), value: 'name' },
    { label: i18n.__('Reference'), value: 'reference' },
    { label: i18n.__('Properties'), value: 'properties' },
    { label: i18n.__('Contract begin date'), value: 'beginDate' },
    { label: i18n.__('Contract end date'), value: 'endDate' },
    { label: i18n.__('Contract termination date'), value: 'terminationDate' },
    { label: i18n.__('Deposit'), value: 'guaranty' },
    { label: i18n.__('Refunded deposit'), value: 'guarantyPayback' },
    { label: i18n.__('Last rent balance'), value: 'balance' },
    { label: i18n.__('Final balance'), value: 'finalBalance' }
  ];

  const json2csv = new Parser({ fields, delimiter: ';', withBOM: true });
  const csv = json2csv.parse(data);
  res.header('Content-Type', 'text/csv');
  return res.send(csv);
}

async function settlementsAsCsv(req: Req, res: Res) {
  const realm = req.realm!;
  const realmId = String(realm._id);
  const year = req.params?.year
    ? validateYear(req.params.year, 'year')
    : new Date().getFullYear();
  i18n.setLocale(realm.locale);

  const tenants = await _fetchData(realmId, year);
  // (numeric cells are written raw + a currency numFmt applied via exceljs, so
  // no string currency formatter is needed for the xlsx export.)
  const months = moment.localeData(realm.locale).months();

  // CS1+CS2: export as a real .xlsx (not .csv) so column widths + a currency
  // number-format are controllable (a CSV is plain text and carries neither —
  // Excel auto-widths on open, which is what the user saw). Layout A: per month
  // a PAIR of columns — πληρωμή (paid) and οφειλή (owed = max(0, grandTotal −
  // payment) for that month's rent) — plus two summary sums per tenant
  // (Σύνολο πληρωμών / Σύνολο οφειλών). MONEY: the row sums must equal the 12
  // paid / 12 owed cells, and paid must reconcile with the rent's total.payment.
  const monthNames = months as unknown as string[];
  const rows = tenants.map((tenant: AnyRecord) => {
    const _endRaw = tenant.terminationDate || tenant.endDate;
    const beginDate = tenant.beginDate
      ? moment.utc(tenant.beginDate).format('YYYY-MM-DD')
      : '';
    const endDate = _endRaw ? moment.utc(_endRaw).format('YYYY-MM-DD') : '';
    const properties = _sanitizeCsvText(
      (tenant.properties || []).map(({ name }: AnyRecord) => name).join(', ')
    );

    // Per month: paid = Σ payment amounts; owed = THIS month's shortfall.
    // rent.total.grandTotal is CUMULATIVE — it carries every prior unpaid month
    // via rent.total.balance (5_balance/7_total). Summing max(0, grandTotal −
    // payment) across months re-adds the arrears every month (a €1,500 debt
    // would print as €3,000; 6 months blows up quadratically). Strip the
    // carried-in balance first so each cell is THIS month's bill, matching the
    // canonical formula in frontdata.ts + the A2 dashboard tile (_toBuildingData).
    const paidByMonth: number[] = new Array(12).fill(0);
    const owedByMonth: number[] = new Array(12).fill(0);
    (tenant.rents || []).forEach((rent: AnyRecord) => {
      const mi = Number(rent.month) - 1;
      if (mi < 0 || mi > 11) return;
      const paid = (rent.payments || []).reduce(
        (s: number, p: AnyRecord) => s + (Number(p.amount) || 0),
        0
      );
      const grand = Number(rent?.total?.grandTotal) || 0;
      const payment = Number(rent?.total?.payment) || 0;
      const balance = Number(rent?.total?.balance) || 0;
      const monthDue = Math.max(0, grand - Math.max(0, balance));
      paidByMonth[mi] = _round(paid);
      owedByMonth[mi] = _round(Math.max(0, monthDue - payment));
    });
    const totalPaid = _round(paidByMonth.reduce((s, v) => s + v, 0));
    const totalOwed = _round(owedByMonth.reduce((s, v) => s + v, 0));

    return {
      name: _sanitizeCsvText(tenant.name),
      reference: _sanitizeCsvText(tenant.reference),
      properties,
      beginDate,
      endDate,
      deposit: _round(tenant.guaranty || 0),
      paidByMonth,
      owedByMonth,
      totalPaid,
      totalOwed
    };
  });

  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(i18n.__('Payments'));

  // Column definitions: id cols, then per-month (paid, owed) pairs, then sums.
  const columns: AnyRecord[] = [
    { header: i18n.__('Name'), key: 'name', width: 28 },
    { header: i18n.__('Reference'), key: 'reference', width: 16 },
    { header: i18n.__('Properties'), key: 'properties', width: 24 },
    { header: i18n.__('Contract begin date'), key: 'beginDate', width: 14 },
    { header: i18n.__('Contract end date'), key: 'endDate', width: 14 },
    { header: i18n.__('Deposit'), key: 'deposit', width: 12 }
  ];
  monthNames.forEach((m, i) => {
    columns.push({ header: `${m} (${i18n.__('Payment')})`, key: `p${i}`, width: 13 });
    columns.push({ header: `${m} (${i18n.__('Owed')})`, key: `o${i}`, width: 13 });
  });
  columns.push({ header: i18n.__('Total payments'), key: 'totalPaid', width: 15 });
  columns.push({ header: i18n.__('Total owed'), key: 'totalOwed', width: 15 });
  ws.columns = columns as any;

  // el-GR-style currency number format ("#.##0,00 €") derived from the realm
  // currency; exceljs uses the workbook locale-independent mask, so we build a
  // euro mask with comma decimal + dot thousands to match the app convention.
  const moneyFmt = '#,##0.00';

  rows.forEach((r: AnyRecord) => {
    const rowObj: AnyRecord = {
      name: r.name,
      reference: r.reference,
      properties: r.properties,
      beginDate: r.beginDate,
      endDate: r.endDate,
      deposit: r.deposit,
      totalPaid: r.totalPaid,
      totalOwed: r.totalOwed
    };
    for (let i = 0; i < 12; i++) {
      // leave blank (not 0) for months with no activity, matching the prior CSV.
      rowObj[`p${i}`] = r.paidByMonth[i] > 0 ? r.paidByMonth[i] : null;
      rowObj[`o${i}`] = r.owedByMonth[i] > 0 ? r.owedByMonth[i] : null;
    }
    const added = ws.addRow(rowObj);
    // apply the currency format to all numeric (deposit + month pairs + sums).
    ['deposit', 'totalPaid', 'totalOwed'].forEach((k) => {
      const c = added.getCell(k);
      if (typeof c.value === 'number') c.numFmt = moneyFmt;
    });
    for (let i = 0; i < 12; i++) {
      ['p', 'o'].forEach((pre) => {
        const c = added.getCell(`${pre}${i}`);
        if (typeof c.value === 'number') c.numFmt = moneyFmt;
      });
    }
  });
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];

  const buffer = await wb.xlsx.writeBuffer();
  res.header(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  return res.send(Buffer.from(buffer));
}

// OS4/OS6: the OWNER-side twin of settlementsAsCsv — owner καταβολές vs
// outstanding per month, as a .xlsx. Same layout (id cols + per-month
// πληρωμή/οφειλή pairs + Σύνολα), but over owner-ledger data: paid-by-month
// from each charge's payments[] grouped by term→month, owed-by-month from each
// charge's NETTED `outstanding` (the same figure _aggregateOwners / the owner
// statement show). Year-scoped via _aggregateOwners(..., year).
async function ownerSettlementsAsCsv(req: Req, res: Res) {
  const realm = req.realm!;
  const realmId = String(realm._id);
  const year = req.params?.year
    ? validateYear(req.params.year, 'year')
    : new Date().getFullYear();
  i18n.setLocale(realm.locale);

  const buildings = await Collections.Building.find({ realmId }).lean();
  const occupiedKeys = await OwnerManager._occupiedKeysForBuildings(
    realmId,
    buildings as AnyRecord[]
  );
  const owners = OwnerManager._aggregateOwners(
    buildings as AnyRecord[],
    occupiedKeys,
    year
  );
  await OwnerManager._markAlsoRents(realmId, owners);

  const monthNames = moment
    .localeData(realm.locale)
    .months() as unknown as string[];

  const rows = Array.from(owners.values()).map((agg: AnyRecord) => {
    const paidByMonth: number[] = new Array(12).fill(0);
    const owedByMonth: number[] = new Array(12).fill(0);
    for (const c of agg.charges || []) {
      // term YYYYMM..; month index 0-11. Year already scoped by _aggregateOwners.
      const mi = Math.floor((Number(c.term) % 1000000) / 10000) - 1;
      if (mi < 0 || mi > 11) continue;
      // Use the charge's SETTLED paidAmount (from _aggregateOwners), NOT a raw
      // re-sum of payments[]. A tile-flagged cashless row (flag=settled) has
      // paidAmount == its billed amount but EMPTY payments[]; re-summing
      // payments[] would show €0 in the month cell while the total (agg.totalPaid,
      // which includes the lift) showed the full amount → the sheet's Σ(monthly
      // Payment columns) ≠ Total payments, an unreconcilable gap (flag-lift Step-7
      // MEDIUM). Reading paidAmount makes the month cells AND the total both
      // reflect settlement, so the export self-reconciles (Σ months === total).
      paidByMonth[mi] = _round(paidByMonth[mi] + (Number(c.paidAmount) || 0));
      owedByMonth[mi] = _round(owedByMonth[mi] + (Number(c.outstanding) || 0));
    }
    // Total = Σ of the month cells so the sheet always reconciles column-to-total
    // (mirrors the rent twin settlementsAsCsv, which also derives totalPaid from
    // paidByMonth rather than agg.totalPaid).
    const totalPaid = _round(paidByMonth.reduce((s, v) => s + v, 0));
    return {
      name: _sanitizeCsvText(agg.name || ''),
      taxId: _sanitizeCsvText(agg.taxId || ''),
      units: Number(agg.unitCount) || 0,
      buildings: agg.buildingIds ? agg.buildingIds.size : 0,
      paidByMonth,
      owedByMonth,
      totalPaid,
      totalOwed: _round(Number(agg.totalOutstanding) || 0)
    };
  });
  // Useful default order: biggest outstanding first, then name.
  rows.sort(
    (a, b) => b.totalOwed - a.totalOwed || a.name.localeCompare(b.name)
  );

  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(i18n.__('Owner payments'));
  const columns: AnyRecord[] = [
    { header: i18n.__('Name'), key: 'name', width: 28 },
    { header: i18n.__('Tax ID'), key: 'taxId', width: 16 },
    { header: i18n.__('Units'), key: 'units', width: 10 },
    { header: i18n.__('Buildings'), key: 'buildings', width: 10 }
  ];
  monthNames.forEach((m, i) => {
    columns.push({ header: `${m} (${i18n.__('Payment')})`, key: `p${i}`, width: 13 });
    columns.push({ header: `${m} (${i18n.__('Owed')})`, key: `o${i}`, width: 13 });
  });
  columns.push({ header: i18n.__('Total payments'), key: 'totalPaid', width: 15 });
  columns.push({ header: i18n.__('Total owed'), key: 'totalOwed', width: 15 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ws.columns = columns as any;

  const moneyFmt = '#,##0.00';
  rows.forEach((r: AnyRecord) => {
    const rowObj: AnyRecord = {
      name: r.name,
      taxId: r.taxId,
      units: r.units,
      buildings: r.buildings,
      totalPaid: r.totalPaid,
      totalOwed: r.totalOwed
    };
    for (let i = 0; i < 12; i++) {
      rowObj[`p${i}`] = r.paidByMonth[i] > 0 ? r.paidByMonth[i] : null;
      rowObj[`o${i}`] = r.owedByMonth[i] > 0 ? r.owedByMonth[i] : null;
    }
    const added = ws.addRow(rowObj);
    ['totalPaid', 'totalOwed'].forEach((k) => {
      const c = added.getCell(k);
      if (typeof c.value === 'number') c.numFmt = moneyFmt;
    });
    for (let i = 0; i < 12; i++) {
      ['p', 'o'].forEach((pre) => {
        const c = added.getCell(`${pre}${i}`);
        if (typeof c.value === 'number') c.numFmt = moneyFmt;
      });
    }
  });
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];

  const buffer = await wb.xlsx.writeBuffer();
  res.header(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  return res.send(Buffer.from(buffer));
}

export const csv = {
  incomingTenants: incomingTenantsAsCsv,
  outgoingTenants: outgoingTenantsAsCsv,
  settlements: settlementsAsCsv,
  ownerSettlements: ownerSettlementsAsCsv
};
