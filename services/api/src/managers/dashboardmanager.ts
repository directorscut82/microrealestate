import { Collections, logger } from '@microrealestate/common';
import type { ServiceRequest, ServiceResponse } from '@microrealestate/types';
import moment from 'moment';

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
 * Wave-26 round-3r: per-bucket paid amount for the dashboard pie chart.
 *
 * Pre-condition: every payment carries an explicit `allocation[]`.
 * rentmanager.ts auto-spreads on save when the user didn't pick a mode,
 * and the round-3r migration script backfills legacy payments. So this
 * function is a straight aggregator: read each payment's allocation,
 * map rent-pipeline categories onto the dashboard's display buckets,
 * sum.
 *
 * Mapping rent-pipeline category -> dashboard bucket:
 *   'rent'              -> 'rent'                  (single bucket)
 *   'expenses'          -> 'charges' + 'building:<non-repair-type>'
 *                          (prorated by owed amount within those keys)
 *   'repairs'           -> 'building:<repair-type>'
 *                          (prorated within repair-typed buildings)
 *   'vat'/'previousBalance'/'extracharge' -> not visualised (skipped)
 *
 * Bucket space (matches pie segment `type`):
 *   - 'rent'                  (rent.total.preTaxAmount)
 *   - 'charges'               (per-property extra charges, sum)
 *   - 'building:<type>'       (each entry of buildingChargesByType)
 */
export function _computePaidByBucket(rent: AnyRecord): AnyRecord {
  const buckets: AnyRecord = {};
  const charges = (rent.charges || []).reduce(
    (s: number, c: AnyRecord) => s + (Number(c.amount) || 0),
    0
  );
  const buildingByType: AnyRecord = {};
  (rent.buildingCharges || []).forEach((c: AnyRecord) => {
    const t = c.type || 'other';
    buildingByType[t] = (buildingByType[t] || 0) + (Number(c.amount) || 0);
  });

  const _add = (bucket: string, amount: number) => {
    if (amount <= 0) return;
    buckets[bucket] = (buckets[bucket] || 0) + amount;
  };

  // Prorate `amount` across `keys` weighted by `weights[key]`. Skips
  // zero-weight keys. Pure proportional split, no spillover — caller
  // guarantees keys is non-empty and total weight > 0.
  const _prorate = (
    amount: number,
    keys: string[],
    weights: AnyRecord
  ) => {
    const total = keys.reduce(
      (s, k) => s + Math.max(0, Number(weights[k]) || 0),
      0
    );
    if (total <= 0) return;
    keys.forEach((k) => {
      const w = Math.max(0, Number(weights[k]) || 0);
      if (w <= 0) return;
      _add(k, (amount * w) / total);
    });
  };

  (rent.payments || []).forEach((p: AnyRecord) => {
    const allocation = Array.isArray(p?.allocation) ? p.allocation : [];
    allocation.forEach((a: AnyRecord) => {
      const cat = String(a?.category || '');
      const amt = Number(a?.amount) || 0;
      if (amt <= 0) return;

      if (cat === 'rent') {
        _add('rent', amt);
        return;
      }
      if (cat === 'expenses') {
        // Spread across per-property charges + non-repair buildings,
        // weighted by their owed amount. Single-key cases collapse to
        // the obvious answer.
        const weights: AnyRecord = { charges };
        Object.keys(buildingByType)
          .filter((t) => t !== 'repair')
          .forEach((t) => {
            weights[`building:${t}`] = buildingByType[t];
          });
        _prorate(amt, Object.keys(weights), weights);
        return;
      }
      if (cat === 'repairs') {
        const repairKeys = Object.keys(buildingByType)
          .filter((t) => t === 'repair')
          .map((t) => `building:${t}`);
        const weights: AnyRecord = {};
        repairKeys.forEach((k) => {
          const t = k.slice('building:'.length);
          weights[k] = buildingByType[t] || 0;
        });
        _prorate(amt, repairKeys, weights);
        return;
      }
      // vat / previousBalance / extracharge: not on the pie.
    });
  });

  Object.keys(buckets).forEach((k) => {
    buckets[k] = _round(buckets[k]);
  });
  return buckets;
}

export async function all(req: Req, res: Res) {
  const now = moment.utc();
  const beginOfTheMonth = moment.utc(now).startOf('month');
  const endOfTheMonth = moment.utc(now).endOf('month');
  const beginOfTheYear = moment.utc(now).startOf('year');
  const endOfTheYear = moment.utc(now).endOf('year');

  const realmId = req.realm!._id;
  const yearStr = String(now.year());
  const prevYearStr = String(now.year() - 1);

  // Load tenants with only needed fields and rents filtered to current year
  const allTenants: AnyRecord[] = await Collections.Tenant.aggregate([
    { $match: { realmId } },
    {
      $project: {
        name: 1,
        firstName: 1,
        lastName: 1,
        terminationDate: 1,
        endDate: 1,
        'properties.propertyId': 1,
        rents: {
          $filter: {
            input: '$rents',
            as: 'r',
            cond: {
              $in: [
                { $substrBytes: [{ $toString: '$$r.term' }, 0, 4] },
                [yearStr, prevYearStr]
              ]
            }
          }
        }
      }
    }
  ]);

  const activeTenants = allTenants.reduce(
    (acc: AnyRecord[], tenant: AnyRecord) => {
      const terminationMoment = tenant.terminationDate
        ? moment.utc(tenant.terminationDate)
        : moment.utc(tenant.endDate);

      if (terminationMoment.isSameOrAfter(now, 'day')) {
        acc.push(tenant);
      }

      return acc;
    },
    []
  );
  const tenantCount = activeTenants.length;

  // Wave-20 F9: exclude building shells from the rentable count. A
  // type='building' Property is a building wrapper, not a rentable unit;
  // including it inflates propertyCount and dilutes occupancyRate.
  const propertyCount = await Collections.Property.countDocuments({
    realmId,
    type: { $ne: 'building' }
  });

  // Compute occupancy rate excluding owner_occupied and parking units
  let occupancyRate: number | undefined;
  if (propertyCount > 0) {
    const buildings: AnyRecord[] = await Collections.Building.find({
      realmId
    }).lean();

    const nonRentablePropertyIds = new Set<string>();
    for (const building of buildings) {
      for (const unit of building.units || []) {
        if (
          unit.propertyId &&
          (unit.occupancyType === 'owner_occupied' ||
            unit.occupancyType === 'parking')
        ) {
          nonRentablePropertyIds.add(String(unit.propertyId));
        }
      }
    }

    const rentablePropertyCount = propertyCount - nonRentablePropertyIds.size;

    if (rentablePropertyCount > 0) {
      const countPropertyRented = activeTenants.reduce(
        (acc: Set<string>, { properties = [] }: AnyRecord) => {
          properties.forEach(({ propertyId }: AnyRecord) => {
            if (!nonRentablePropertyIds.has(String(propertyId))) {
              acc.add(propertyId);
            }
          });
          return acc;
        },
        new Set<string>()
      ).size;
      occupancyRate = countPropertyRented / rentablePropertyCount;
    } else {
      occupancyRate = 0;
    }
  }

  let totalYearRevenues = 0;

  if (allTenants.length > 0) {
    totalYearRevenues = allTenants.reduce(
      (total: number, { rents = [] }: AnyRecord) => {
        let sumPayments = 0;
        rents.forEach((rent: AnyRecord) => {
          (rent.payments || []).forEach((payment: AnyRecord) => {
            if (!payment.date || Number(payment.amount) === 0) {
              return;
            }

            const paymentMoment = moment.utc(payment.date, 'DD/MM/YYYY');
            if (
              paymentMoment.isBetween(
                beginOfTheYear,
                endOfTheYear,
                'day',
                '[]'
              )
            ) {
              sumPayments = sumPayments + payment.amount;
            }
          });
        });

        return total + sumPayments;
      },
      0
    );
    // Round once at the outer aggregate; nested .reduce on Number adds noise.
    totalYearRevenues = _round(totalYearRevenues);
  }

  const overview =
    tenantCount || propertyCount
      ? {
          tenantCount,
          propertyCount,
          occupancyRate,
          totalYearRevenues
        }
      : null;

  const topUnpaid =
    tenantCount || propertyCount
      ? activeTenants
          .reduce((acc: AnyRecord[], tenant: AnyRecord) => {
            const currentRent = (tenant.rents || []).find(
              (rent: AnyRecord) => {
                const termMoment =
                  rent.term && moment.utc(rent.term, 'YYYYMMDDHH');
                return (
                  termMoment &&
                  termMoment.isBetween(
                    beginOfTheMonth,
                    endOfTheMonth,
                    'day',
                    '[]'
                  )
                );
              }
            );
            if (currentRent) {
              const balance = _round(
                (currentRent.total?.payment || 0) -
                  (currentRent.total?.grandTotal || 0)
              );
              acc.push({
                tenant: { _id: tenant._id, name: _tenantName(tenant) },
                balance
              });
            }
            return acc;
          }, [])
          .sort((t1: AnyRecord, t2: AnyRecord) => t1.balance - t2.balance)
          .filter((t: AnyRecord) => t.balance < 0)
          .slice(0, 5)
      : [];

  const emptyRevenues = moment
    .months()
    .reduce((acc: AnyRecord, _month: string, index: number) => {
      const key = moment
        .utc(`${index + 1}/${now.year()}`, 'MM/YYYY')
        .format('MMYYYY');
      acc[key] = {
        month: key,
        paid: 0,
        notPaid: 0,
        baseRent: 0,
        charges: 0,
        buildingCharges: 0,
        buildingChargesByType: {},
        tenants: []
      };
      return acc;
    }, {});

  const revenues = Object.entries(
    allTenants.reduce((acc: AnyRecord, tenant: AnyRecord) => {
      const tenantName = _tenantName(tenant);
      (tenant.rents || []).forEach((rent: AnyRecord) => {
        const termMoment = moment.utc(rent.term, 'YYYYMMDDHH');
        if (
          !termMoment.isBetween(beginOfTheYear, endOfTheYear, 'day', '[]')
        ) {
          return;
        }
        const key = termMoment.format('MMYYYY');

        const tenantBaseRent = rent.total?.preTaxAmount || 0;
        const tenantCharges = (rent.charges || []).reduce(
          (sum: number, c: AnyRecord) => sum + (c.amount || 0),
          0
        );
        const tenantBuildingCharges = (rent.buildingCharges || []).reduce(
          (sum: number, c: AnyRecord) => sum + (c.amount || 0),
          0
        );
        const tenantBuildingByType: AnyRecord = {};
        (rent.buildingCharges || []).forEach((c: AnyRecord) => {
          const t = c.type || 'other';
          tenantBuildingByType[t] =
            (tenantBuildingByType[t] || 0) + (c.amount || 0);
        });
        const tenantDue = rent.total?.grandTotal || 0;
        const tenantPaid = rent.total?.payment || 0;

        if (!acc[key]) {
          acc[key] = {
            month: key,
            paid: 0,
            notPaid: 0,
            baseRent: 0,
            charges: 0,
            buildingCharges: 0,
            buildingChargesByType: {},
            tenants: []
          };
        }

        acc[key].paid += tenantPaid;
        // Wave-14 F5: notPaid is the unsigned shortfall on THIS MONTH'S bill
        // only — exclude balance carry-forward so summing the column doesn't
        // double-count prior months. The internal cumulative ledger
        // (rent.total.balance) is unchanged; only this aggregator output
        // is per-month.
        const tenantBalance = rent.total?.balance || 0;
        const tenantMonthDue = tenantDue - tenantBalance;
        acc[key].notPaid +=
          tenantPaid < tenantMonthDue ? tenantMonthDue - tenantPaid : 0;
        acc[key].baseRent += tenantBaseRent;
        acc[key].charges += tenantCharges;
        acc[key].buildingCharges += tenantBuildingCharges;
        Object.entries(tenantBuildingByType).forEach(([type, amount]) => {
          acc[key].buildingChargesByType[type] =
            (acc[key].buildingChargesByType[type] || 0) + (amount as number);
        });
        // Wave-26 round-3i: per-bucket paid amount, accurate down to the
        // wire format so the dashboard tooltip can show real numbers
        // instead of paidRatio estimates.
        const tenantPaidByBucket = _computePaidByBucket(rent);
        acc[key].tenants.push({
          name: tenantName,
          paid: tenantPaid,
          due: tenantDue,
          baseRent: tenantBaseRent,
          charges: tenantCharges,
          buildingCharges: tenantBuildingCharges,
          buildingChargesByType: tenantBuildingByType,
          paidByBucket: tenantPaidByBucket
        });
      });
      return acc;
    }, emptyRevenues)
  )
    .map(([, value]) => {
      const v = value as AnyRecord;
      // Round every aggregated field (sums of floats accumulate FP drift).
      // Nested per-type and per-tenant breakdowns must be rounded too —
      // the dashboard sums them on the client.
      const buildingChargesByType: AnyRecord = {};
      Object.entries(v.buildingChargesByType || {}).forEach(
        ([type, amount]) => {
          buildingChargesByType[type] = _round(amount as number);
        }
      );
      return {
        ...v,
        paid: _round(v.paid),
        // Math.abs is a belt-and-braces guard: the accumulator is already
        // computed as the unsigned shortfall, but FP drift on the running
        // sum could in theory leave a -0.0 here.
        notPaid: Math.abs(_round(v.notPaid)),
        baseRent: _round(v.baseRent),
        charges: _round(v.charges),
        buildingCharges: _round(v.buildingCharges),
        buildingChargesByType,
        tenants: (v.tenants || []).map((t: AnyRecord) => {
          const byType: AnyRecord = {};
          Object.entries(t.buildingChargesByType || {}).forEach(
            ([type, amount]) => {
              byType[type] = _round(amount as number);
            }
          );
          const paidByBucket: AnyRecord = {};
          Object.entries(t.paidByBucket || {}).forEach(([k, amount]) => {
            paidByBucket[k] = _round(amount as number);
          });
          return {
            ...t,
            paid: _round(t.paid),
            due: _round(t.due),
            baseRent: _round(t.baseRent),
            charges: _round(t.charges),
            buildingCharges: _round(t.buildingCharges),
            buildingChargesByType: byType,
            paidByBucket
          };
        })
      };
    })
    .sort((r1: AnyRecord, r2: AnyRecord) =>
      moment.utc(r1.month, 'MMYYYY').isBefore(moment.utc(r2.month, 'MMYYYY'))
        ? -1
        : 1
    );

  // Pending bills grouped by building
  let pendingBills: AnyRecord[] = [];
  try {
    pendingBills = await _fetchPendingBills(realmId);
  } catch (error) {
    logger.error(`Failed to fetch pending bills: ${String(error)}`);
  }

  res.json({
    overview,
    topUnpaid,
    revenues,
    pendingBills
  });
}

function _tenantName(tenant: AnyRecord): string {
  return (
    tenant.name ||
    `${tenant.firstName || ''} ${tenant.lastName || ''}`.trim()
  );
}

async function _fetchPendingBills(realmId: string): Promise<AnyRecord[]> {
  const bills: AnyRecord[] = await Collections.Bill.find({
    realmId,
    status: 'pending'
  })
    .sort({ dueDate: 1 })
    .lean();

  if (!bills.length) return [];

  // Get building names for grouping
  const buildingIds = [...new Set(bills.map((b) => b.buildingId))];
  const buildings: AnyRecord[] = await Collections.Building.find(
    { _id: { $in: buildingIds } },
    { name: 1, expenses: 1 }
  ).lean();
  const buildingMap = new Map(
    buildings.map((b) => [String(b._id), b.name])
  );
  const expenseMap = new Map<string, string>();
  for (const b of buildings as AnyRecord[]) {
    for (const exp of b.expenses || []) {
      expenseMap.set(String(exp._id), exp.name);
    }
  }

  // Group by building
  const grouped: AnyRecord = {};
  for (const bill of bills) {
    const buildingId = String(bill.buildingId);
    if (!grouped[buildingId]) {
      grouped[buildingId] = {
        buildingId,
        buildingName: buildingMap.get(buildingId) || 'Unknown',
        bills: []
      };
    }
    grouped[buildingId].bills.push({
      _id: bill._id,
      expenseName: expenseMap.get(String(bill.expenseId)) || bill.provider,
      totalAmount: bill.totalAmount,
      dueDate: bill.dueDate,
      periodStart: bill.periodStart,
      periodEnd: bill.periodEnd
    });
  }

  return Object.values(grouped);
}
