import { Collections } from '@microrealestate/common';
import type { ServiceRequest, ServiceResponse } from '@microrealestate/types';
import i18n from 'i18n';
import moment from 'moment';
import { Parser } from 'json2csv';
import { validateYear } from '../validators.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = ServiceRequest<any, any, any>;
type Res = ServiceResponse;
type AnyRecord = Record<string, any>;

// Avoid floating-point drift on aggregated sums (e.g. 6624.399999999999).
// Round every aggregate result before returning to API consumers.
function _round(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
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
              total: '$$rent.total'
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

  return tenant.properties.map(({ name }: AnyRecord) => name).join('\n');
}

function _incomingTenants(
  tenants: AnyRecord[],
  locale?: string,
  currency?: string,
  rawData = true
): AnyRecord[] {
  const NumberFormat = !rawData
    ? Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        minimumFractionDigits: 2
      })
    : { format: (value: number) => value };

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
        name: tenant.name,
        reference: tenant.reference,
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
  const NumberFormat = !rawData
    ? Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        minimumFractionDigits: 2
      })
    : { format: (value: number) => value };

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
        name: tenant.name,
        reference: tenant.reference,
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
  const NumberFormat = Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2
  });

  const months = moment.localeData(locale).months();

  return tenants.map((tenant: AnyRecord) => {
    // Pin CSV dates to ISO (YYYY-MM-DD); see _incomingTenants for rationale.
    const beginDate = rawData
      ? tenant.beginDate
      : moment.utc(tenant.beginDate).format('YYYY-MM-DD');
    const endDate = rawData
      ? tenant.terminationDate || tenant.endDate
      : moment.utc(tenant.terminationDate || tenant.endDate).format(
          'YYYY-MM-DD'
        );
    const settlements: AnyRecord = rawData
      ? (months as unknown as string[]).map(() => null)
      : (months as unknown as string[]).reduce((acc: AnyRecord, m: string) => {
          acc[m] = '';
          return acc;
        }, {});

    tenant.rents.forEach(({ month, payments }: AnyRecord) => {
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
            return `${isoDate} ${i18n.__(
              type
            )} ${reference}\n${NumberFormat.format(amount)}`;
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
          settlements
        }
      : {
          tenantId: tenant._id,
          tenant: rawData
            ? tenant.name
            : `${tenant.name}\n${
                tenant.reference
              }\n${beginDate} - ${endDate}\n${i18n.__('Deposit: {{deposit}}', {
                deposit: NumberFormat.format(_round(tenant.guaranty || 0))
              })}\n${tenant.properties.map(({ name }: AnyRecord) => name).join('\n')}`,
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
  const data = _settlements(tenants, realm.locale, realm.currency, false);
  const months = moment.localeData(realm.locale).months();
  const fields = [
    { label: i18n.__('Tenant'), value: 'tenant' },
    ...(months as unknown as string[])
  ];

  const json2csv = new Parser({ fields, delimiter: ';', withBOM: true });
  const csv = json2csv.parse(data);
  res.header('Content-Type', 'text/csv');
  return res.send(csv);
}

export const csv = {
  incomingTenants: incomingTenantsAsCsv,
  outgoingTenants: outgoingTenantsAsCsv,
  settlements: settlementsAsCsv
};
