import { BuildingProjection, Collections, logger, OwnerStatement } from '@microrealestate/common';
import type { ServiceRequest, ServiceResponse } from '@microrealestate/types';
import moment from 'moment';
import { _isSettledByCarryForward } from './frontdata.js';
import { computeOwnerEksodaByMonth } from './buildingmanager.js';

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
      const lineKey = a?.lineKey ? String(a.lineKey) : '';
      const amt = Number(a?.amount) || 0;
      if (amt <= 0) return;

      // B1 fast-path: payments with explicit lineKey are attributed to
      // the exact source line. No prorate needed — the dialog (or
      // caller) already decided which line to pay.
      if (lineKey) {
        if (cat === 'rent' || cat === 'previousBalance' ||
            cat === 'vat' || cat === 'extracharge') {
          if (cat === 'rent') _add('rent', amt);
          // vat/previousBalance/extracharge: not on the pie (line 113
          // comment). Drop them silently as before.
          return;
        }
        if (cat === 'propertyCharge') {
          // lineKey is 'charges:<idx>' — pay one specific property
          // charge. Aggregate into the same 'charges' bucket the pie
          // already renders (no per-property fan-out needed since the
          // dashboard's per-tenant charges field is a single number).
          _add('charges', amt);
          return;
        }
        if (cat === 'buildingCharge' || cat === 'repair') {
          // lineKey is 'building:<idx>'. Resolve back to the type by
          // looking up the underlying buildingCharges array entry.
          const m = lineKey.match(/^building:(\d+)$/);
          const idx = m ? Number(m[1]) : -1;
          const entry = idx >= 0
            ? (rent.buildingCharges || [])[idx]
            : null;
          const type = entry?.type || (cat === 'repair' ? 'repair' : 'other');
          _add(`building:${type}`, amt);
          return;
        }
      }

      // Legacy fallback: payments without lineKey use the pre-B1
      // prorate-by-owed reconstruction.
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

// --------------------------------------------------------------------------
// Pure dashboard computations (M3 test-integrity).
//
// These were inlined inside `all()`; the dashboard.test.js suite re-implemented
// each as a hand-copied "mirror" because there was nothing to import. Those
// mirrors silently DRIFTED from production (the mirror's revenue total lacked
// the M6 VAT/allocation exclusion; its notPaid kept the pre-Wave-26 signed
// value; its top-unpaid lacked the carry-forward settle check) so the suite was
// green while asserting a contract the API no longer ships. Extracted verbatim
// and exported so the test imports the SAME code the handler runs — a future
// drift now fails the build, not just the (deleted) mirror.
// --------------------------------------------------------------------------

// Active = has ≥1 property AND (terminationDate||endDate) is a valid date that
// is not before `now` (both UTC). See the T2.1 note in `all()`.
export function _computeActiveTenants(
  allTenants: AnyRecord[],
  now: moment.Moment
): AnyRecord[] {
  return allTenants.reduce((acc: AnyRecord[], tenant: AnyRecord) => {
    if (!tenant.properties?.length) return acc;
    const endValue = tenant.terminationDate || tenant.endDate;
    if (!endValue) return acc;
    const endMoment = moment.utc(endValue);
    if (!endMoment.isValid()) return acc;
    if (endMoment.isSameOrAfter(now, 'day')) {
      acc.push(tenant);
    }
    return acc;
  }, []);
}

// Occupancy excludes owner_occupied + parking units from both numerator and
// denominator. Returns 0 when no rentable property exists.
export function _computeOccupancyRate(
  activeTenants: AnyRecord[],
  propertyCount: number,
  buildings: AnyRecord[],
  now?: moment.Moment
): number {
  // An ACTIVE tenant outranks the stored owner_occupied/parking flag (Finding
  // B): when an owner moved out and a tenant was linked, the unit keeps its
  // owner_occupied flag (the money layer owns it; a scalar can't be per-term),
  // but for occupancy it is genuinely rented — so it must count as rentable AND
  // rented, not be excluded. Build the active-tenant propertyId set first, then
  // exclude a flagged unit ONLY when it has no active tenant.
  //
  // Step-7 r2: a FUTURE-START lease (beginDate after now) is NOT occupying yet,
  // so it must not make the property count as rented (nor un-exclude an
  // owner_occupied/parking unit). activeTenants is already end-windowed by
  // _computeActiveTenants; add the begin-window here (occupancy-rate-local, so
  // the headline tenant count that also uses activeTenants is untouched). When
  // `now` is omitted (legacy callers/tests) the begin-window is skipped.
  const activeRentedPropertyIds = new Set<string>();
  for (const tenant of activeTenants) {
    if (now && tenant.beginDate) {
      const begin = moment.utc(tenant.beginDate);
      if (begin.isValid() && begin.isAfter(now, 'month')) continue;
    }
    for (const { propertyId } of (tenant.properties || []) as AnyRecord[]) {
      if (propertyId) activeRentedPropertyIds.add(String(propertyId));
    }
  }
  const nonRentablePropertyIds = new Set<string>();
  for (const building of buildings) {
    for (const unit of building.units || []) {
      if (
        unit.propertyId &&
        (unit.occupancyType === 'owner_occupied' ||
          unit.occupancyType === 'parking') &&
        !activeRentedPropertyIds.has(String(unit.propertyId))
      ) {
        nonRentablePropertyIds.add(String(unit.propertyId));
      }
    }
  }
  const rentablePropertyCount = propertyCount - nonRentablePropertyIds.size;
  if (rentablePropertyCount <= 0) return 0;
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
  return countPropertyRented / rentablePropertyCount;
}

// Headline revenue KPI: payments dated within the year, counting ONLY the
// rent/charge income portion (M6 — VAT/deposit/previous-balance/extra-charge
// are pass-through or carry-in, not revenue). An un-allocated legacy payment
// counts in full (it is rent cash).
export function _computeTotalYearRevenues(
  allTenants: AnyRecord[],
  beginOfTheYear: moment.Moment,
  endOfTheYear: moment.Moment
): number {
  if (!(allTenants.length > 0)) return 0;
  const total = allTenants.reduce(
    (runningTotal: number, { rents = [] }: AnyRecord) => {
      let sumPayments = 0;
      rents.forEach((rent: AnyRecord) => {
        (rent.payments || []).forEach((payment: AnyRecord) => {
          if (!payment.date || Number(payment.amount) === 0) {
            return;
          }
          const paymentMoment = moment.utc(payment.date, 'DD/MM/YYYY');
          if (
            paymentMoment.isBetween(beginOfTheYear, endOfTheYear, 'day', '[]')
          ) {
            const allocation = Array.isArray(payment.allocation)
              ? payment.allocation
              : null;
            if (allocation && allocation.length) {
              const NON_REVENUE = new Set([
                'vat',
                'previousBalance',
                'extracharge',
                'deposit'
              ]);
              const nonRevenue = allocation.reduce(
                (s: number, a: AnyRecord) =>
                  NON_REVENUE.has(String(a?.category || ''))
                    ? s + (Number(a?.amount) || 0)
                    : s,
                0
              );
              const income = Math.max(
                0,
                (Number(payment.amount) || 0) - nonRevenue
              );
              sumPayments = sumPayments + income;
            } else {
              sumPayments = sumPayments + payment.amount;
            }
          }
        });
      });
      return runningTotal + sumPayments;
    },
    0
  );
  return _round(total);
}

// "Top 5 unpaid" tile: current-month remaining-owed as a POSITIVE amount,
// excluding tenants whose month is settled by a future-month overpayment
// (mirrors /rents' carry-forward status), biggest debtor first.
export function _computeTopUnpaid(
  activeTenants: AnyRecord[],
  beginOfTheMonth: moment.Moment,
  endOfTheMonth: moment.Moment
): AnyRecord[] {
  return activeTenants
    .reduce((acc: AnyRecord[], tenant: AnyRecord) => {
      const currentRent = (tenant.rents || []).find((rent: AnyRecord) => {
        const termMoment = rent.term && moment.utc(rent.term, 'YYYYMMDDHH');
        return (
          termMoment &&
          termMoment.isBetween(beginOfTheMonth, endOfTheMonth, 'day', '[]')
        );
      });
      if (currentRent) {
        const remaining = _round(
          Math.max(
            0,
            (currentRent.total?.grandTotal || 0) -
              (currentRent.total?.payment || 0)
          )
        );
        const settledByCarry = _isSettledByCarryForward(
          Number(currentRent.term),
          tenant.rents || []
        );
        if (remaining > 0.005 && !settledByCarry) {
          acc.push({
            tenant: { _id: tenant._id, name: _tenantName(tenant) },
            balance: remaining
          });
        }
      }
      return acc;
    }, [])
    .sort((t1: AnyRecord, t2: AnyRecord) => t2.balance - t1.balance)
    .slice(0, 5);
}

// Per-month revenue series (the YearFigures chart + pie). paid/notPaid per
// month, notPaid being the unsigned shortfall on THIS month's bill only (carry
// stripped + clamped ≥0 so a credit can't inflate it). Plus per-tenant lines
// and per-bucket paid for the tooltips.
export function _computeRevenues(
  allTenants: AnyRecord[],
  beginOfTheYear: moment.Moment,
  endOfTheYear: moment.Moment,
  now: moment.Moment
): AnyRecord[] {
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

  return Object.entries(
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
        // Clamp grandTotal at zero. After overpayment carry-forward, a
        // tenant's grandTotal in a future month can be negative (the
        // surplus credit reduces what they owe). Without clamping, that
        // negative number flows into the dashboard "due" aggregates and
        // skews them downward — months with credits look like they have
        // less collectible than they do.
        const tenantDue = Math.max(0, rent.total?.grandTotal || 0);
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
        // Round-1 audit M5: a NEGATIVE balance is a carry-in CREDIT from a
        // prior overpayment, not additional due-this-month. The old
        // `tenantDue - tenantBalance` ADDED the credit's magnitude to this
        // month's due (a 1000 bill with a -200 credit became monthDue 1200),
        // surfacing phantom notPaid for a month the credit already settled.
        // Clamp the carry-in at 0 so a credit can't inflate this month's
        // shortfall. (Step-7: do NOT use _isSettledByCarryForward here — it
        // also returns true for a PAST month settled by a LATER catch-up
        // payment, which would wrongly hide a month whose own rent was never
        // collected that month and break billed = paid + notPaid.)
        const tenantBalance = rent.total?.balance || 0;
        const tenantMonthDue = tenantDue - Math.max(0, tenantBalance);
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
        // B1: per-line detail so the pie tooltip can show actual line
        // descriptions (e.g. 'Επι του ενοικίου', 'τεστε') instead of
        // only the aggregated `type` enum label.
        const chargesLines = (rent.charges || []).map((c: AnyRecord) => ({
          description: String(c?.description || ''),
          amount: Number(c?.amount) || 0
        }));
        const buildingChargesLines = (rent.buildingCharges || []).map(
          (c: AnyRecord) => ({
            description: String(c?.description || ''),
            type: c?.type ? String(c.type) : 'other',
            buildingName: c?.buildingName ? String(c.buildingName) : '',
            amount: Number(c?.amount) || 0
          })
        );
        acc[key].tenants.push({
          name: tenantName,
          paid: tenantPaid,
          due: tenantDue,
          baseRent: tenantBaseRent,
          charges: tenantCharges,
          buildingCharges: tenantBuildingCharges,
          buildingChargesByType: tenantBuildingByType,
          chargesLines,
          buildingChargesLines,
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
          // B1: round per-line amounts so the pie tooltip shows the
          // same precision as the bucket totals.
          const chargesLines = (t.chargesLines || []).map(
            (l: AnyRecord) => ({
              ...l,
              amount: _round(Number(l?.amount) || 0)
            })
          );
          const buildingChargesLines = (t.buildingChargesLines || []).map(
            (l: AnyRecord) => ({
              ...l,
              amount: _round(Number(l?.amount) || 0)
            })
          );
          return {
            ...t,
            paid: _round(t.paid),
            due: _round(t.due),
            baseRent: _round(t.baseRent),
            charges: _round(t.charges),
            buildingCharges: _round(t.buildingCharges),
            buildingChargesByType: byType,
            chargesLines,
            buildingChargesLines,
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
        beginDate: 1,
        terminationDate: 1,
        endDate: 1,
        // N3: needed so the expiring-leases tile can exclude archived tenants
        // to match the scanner (which never notifies archived tenants).
        archived: 1,
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

  // T2.1: a tenant counts as "active" only when:
  //   1) it has at least one property assigned (property-less tenants are
  //      flagged with the amber warning surfaced by T1.7 — they are setup-
  //      incomplete and don't generate rent records, so they shouldn't
  //      inflate the dashboard's active-tenant tile or the occupancy
  //      denominator), AND
  //   2) (terminationDate || endDate) is a valid date that is not in the
  //      past. Both sides of the comparison are kept in UTC. Tenants with
  //      neither field present are treated as inactive — without an end
  //      date we cannot prove the lease is ongoing, and frontdata.ts's
  //      `terminated` flag relies on the same field-pair so the surfaces
  //      stay aligned (frontdata parses with an explicit format which
  //      makes a missing pair Invalid → terminated stays false there; the
  //      practical drift is the same: no end date == not yet billable).
  const activeTenants = _computeActiveTenants(allTenants, now);
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
    occupancyRate = _computeOccupancyRate(
      activeTenants,
      propertyCount,
      buildings,
      now
    );
  }

  const totalYearRevenues = _computeTotalYearRevenues(
    allTenants,
    beginOfTheYear,
    endOfTheYear
  );

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
      ? _computeTopUnpaid(activeTenants, beginOfTheMonth, endOfTheMonth)
      : [];

  const revenues = _computeRevenues(
    allTenants,
    beginOfTheYear,
    endOfTheYear,
    now
  );

  // Pending bills grouped by building
  let pendingBills: AnyRecord[] = [];
  try {
    pendingBills = await _fetchPendingBills(realmId);
  } catch (error) {
    logger.error(`Failed to fetch pending bills: ${String(error)}`);
  }

  // EKSODA rollup (current year, all buildings, incl. repairs). Produces the
  // per-month `expenses[]` series (twin of `revenues`) + the year totals for
  // the Overview "Συνολικά έξοδα για το έτος" row.
  let expensesRollup = {
    totalYearExpenses: 0,
    totalYearPaid: 0,
    expenses: [] as AnyRecord[]
  };
  try {
    expensesRollup = await _expensesRollup(String(realmId), now.year());
  } catch (error) {
    logger.error(`Failed to compute expenses rollup: ${String(error)}`);
  }

  // Fold the year eksoda totals onto the overview so the Overview card can
  // show Έξοδα right under Έσοδα (mirroring totalYearRevenues).
  const overviewWithExpenses = overview
    ? {
        ...overview,
        totalYearExpenses: expensesRollup.totalYearExpenses,
        totalYearExpensesPaid: expensesRollup.totalYearPaid
      }
    : overview;

  // Upcoming expiries — computed live from data already loaded (leases) plus
  // one indexed property query (energy certs). Mirrors the scanner's windows:
  // leases within 30 days, energy certificates (ΠΕΑ, issue+5y) within 60.
  const leaseHorizon = moment.utc(now).add(30, 'days').endOf('day');
  const expiringLeases = allTenants
    .filter((t: AnyRecord) => {
      // N3 (audit-2026-07): match the lease-expiry SCANNER, which excludes
      // archived tenants (buildExpiringFilter: archived $ne true). Without this
      // the dashboard tile lists a tenant that will never receive the notice —
      // the two surfaces disagreed. archived is projected below.
      if (t.archived) return false;
      if (t.terminationDate) return false;
      if (!t.endDate) return false;
      const end = moment.utc(t.endDate);
      return end.isSameOrAfter(now, 'day') && end.isSameOrBefore(leaseHorizon);
    })
    .map((t: AnyRecord) => ({
      tenantId: String(t._id),
      name: t.name,
      endDate: t.endDate,
      daysLeft: moment.utc(t.endDate).startOf('day').diff(moment.utc(now).startOf('day'), 'days')
    }))
    .sort((a: AnyRecord, b: AnyRecord) => a.daysLeft - b.daysLeft);

  const CERT_YEARS = 5;
  const CERT_HORIZON_DAYS = 60;
  // audit-2026-07: widen the mongo pre-filter by a few days on both ends so a
  // leap-year non-commuting date shift (subtract(5y).add(60d) vs the true
  // add(60d).subtract(5y)) can't drop an edge cert; the exact daysLeft bounds
  // below are authoritative. Also clamp the DISPLAY to [0, horizon] so the tile
  // never shows daysLeft:61 under a "within 60 days" header (the old
  // filter(daysLeft>=0) had no upper bound).
  const CERT_FILTER_SLACK_DAYS = 3;
  const certIssueStart = moment
    .utc(now)
    .subtract(CERT_YEARS, 'years')
    .subtract(CERT_FILTER_SLACK_DAYS, 'days')
    .startOf('day')
    .toDate();
  const certIssueEnd = moment
    .utc(now)
    .subtract(CERT_YEARS, 'years')
    .add(CERT_HORIZON_DAYS + CERT_FILTER_SLACK_DAYS, 'days')
    .endOf('day')
    .toDate();
  const certProps: AnyRecord[] = await Collections.Property.find(
    {
      realmId,
      'energyCertificate.issueDate': { $gte: certIssueStart, $lte: certIssueEnd }
    },
    { name: 1, energyCertificate: 1 }
  ).lean();
  const expiringEnergyCerts = certProps
    .map((p: AnyRecord) => {
      const expiresAt = moment.utc(p.energyCertificate.issueDate).add(CERT_YEARS, 'years');
      return {
        propertyId: String(p._id),
        name: p.name,
        issueDate: p.energyCertificate.issueDate,
        expiresAt: expiresAt.toDate(),
        daysLeft: expiresAt.startOf('day').diff(moment.utc(now).startOf('day'), 'days')
      };
    })
    .filter((c: AnyRecord) => c.daysLeft >= 0 && c.daysLeft <= CERT_HORIZON_DAYS)
    .sort((a: AnyRecord, b: AnyRecord) => a.daysLeft - b.daysLeft);

  res.json({
    overview: overviewWithExpenses,
    topUnpaid,
    revenues,
    expenses: expensesRollup.expenses,
    pendingBills,
    expiries: {
      leases: expiringLeases,
      energyCertificates: expiringEnergyCerts
    }
  });
}

// The landlord's EKSODA across every building in the realm — the owner-borne
// expense the landlord must pay, WHATEVER the origin. This explicitly INCLUDES
// ΕΠΙΣΚΕΥΕΣ (repairs): a repair's owner-borne portion lands in
// ownerMonthlyExpenses as source:'repair', and a vacant unit's repair share as
// source:'repair-vacant' — this rollup reads ALL sources, so repairs are
// counted alongside building-expense shares ('expense'/'vacant') and the fixed
// owner amount ('owner-fixed'). (The tenant-billed repair share lives in
// unit.monthlyCharges and is the TENANT's, not the landlord's eksoda, so it is
// correctly excluded.) This is the expense twin of `revenues` (rent income):
// same per-month shape so the dashboard renders Έξοδα with the SAME visuals as
// Έσοδα.
//
// Per row: owed = amount; paid = min(max(Σ payments, paid?amount:0), amount)
// (bridges old checkbox-paid rows + new καταβολές, capped). Bucketed by month
// into the MMYYYY shape `revenues` uses ({month, paid, notPaid}). Returns the
// year total for the Overview "Συνολικά έξοδα για το έτος" row + the per-month
// `expenses[]` series for the Έξοδα charts.
async function _expensesRollup(
  realmId: string,
  year: number
): Promise<{
  totalYearExpenses: number;
  totalYearPaid: number;
  expenses: AnyRecord[];
  owedByBuildingId: Map<string, number>;
}> {
  // Full building docs — computeOwnerEksodaByMonth needs expenses + repairs +
  // units + ownerMonthlyExpenses to compute the owner-borne eksoda LIVE
  // (the ledger alone is near-empty when materialisers never ran — old data).
  const buildings: AnyRecord[] = await Collections.Building.find({
    realmId
  }).lean();

  // Seed all 12 months so the chart shows a full year like the rent chart.
  // term (YYYYMMDDHH) → MMYYYY bucket key (the shape `revenues` uses).
  const byMonth: AnyRecord = {};
  const termToKey: Record<number, string> = {};
  for (let m = 1; m <= 12; m++) {
    const key = moment.utc(`${m}/${year}`, 'MM/YYYY').format('MMYYYY');
    const term = Number(moment.utc(`${m}/${year}`, 'MM/YYYY').format('YYYYMMDDHH'));
    byMonth[key] = { month: key, paid: 0, notPaid: 0, breakdown: [] };
    termToKey[term] = key;
  }

  let totalYearExpenses = 0;
  let totalYearPaid = 0;
  // Per-building owed total, accumulated with the EXACT SAME bucket filter as
  // totalYearExpenses (Step-7 D4 round-2: a separate per-building sum of ALL
  // owedByTerm terms diverged from the headline for any non-day-01 term). One
  // source, one filter → Σ per-building === totalYearExpenses by construction.
  const owedByBuildingId = new Map<string, number>();
  for (const b of buildings) {
    const { owedByTerm, paidByTerm, detailByTerm } =
      await computeOwnerEksodaByMonth(realmId, b, year);
    // Walk the UNION of owed+paid terms. A delete-time 'credit' row contributes
    // PAID with owed=0, so its term may be absent from owedByTerm entirely —
    // iterating owedByTerm alone (and clamping paid≤owed) dropped the preserved
    // καταβολή from the dashboard (Step-7 F1/CREDIT-DASH-1). Paid is NOT clamped
    // to owed here: a credit legitimately has paid>owed(=0). notPaid still uses
    // only the owed-vs-its-own-paid shortfall so a credit's surplus can't make
    // notPaid negative.
    const allTerms = new Set([...owedByTerm.keys(), ...paidByTerm.keys()]);
    let bOwed = 0;
    for (const term of allTerms) {
      const key = termToKey[term];
      const bucket = key ? byMonth[key] : null;
      if (!bucket) continue;
      const owed = owedByTerm.get(term) || 0;
      const paid = paidByTerm.get(term) || 0;
      bucket.paid += paid;
      // notPaid = unpaid remainder of THIS month's owner bill (clamped ≥0 so a
      // credit/overpayment never produces negative notPaid).
      bucket.notPaid += Math.max(0, owed - paid);
      totalYearExpenses += owed;
      totalYearPaid += paid;
      bOwed += owed;
    }
    owedByBuildingId.set(String(b._id), _round(bOwed));
    // Merge this building's per-(owner, category) detail lines into the month
    // bucket so the tooltip can list them (the expense twin of revenues'
    // per-tenant lines). Tagged with the building so the tooltip can show it.
    for (const [term, lines] of detailByTerm || new Map()) {
      const key = termToKey[term];
      const bucket = key ? byMonth[key] : null;
      if (!bucket) continue;
      for (const ln of lines as AnyRecord[]) {
        bucket.breakdown.push({ ...ln, buildingName: b.name || '' });
      }
    }
  }

  const expenses = Object.values(byMonth)
    // Chronological Jan→Dec. Object.values() key order is NOT reliable here: the
    // MMYYYY keys with no leading zero (102026/112026/122026) are integer-like and
    // JS hoists them ahead of the leading-zero string keys (012026…092026), so the
    // raw order came out Oct,Nov,Dec,Jan,… — the chart rendered months out of order.
    // Sort explicitly by term, exactly like `revenues` does (this file, _computeRevenues).
    .sort((v1: AnyRecord, v2: AnyRecord) => {
      // sortable YYYYMM from the MMYYYY key
      const k = (m: string) => Number(String(m).slice(2) + String(m).slice(0, 2));
      return k(v1.month) - k(v2.month);
    })
    .map((v: AnyRecord) => ({
      month: v.month,
      paid: _round(v.paid),
      notPaid: _round(v.notPaid),
      breakdown: (v.breakdown as AnyRecord[])
        .map((d) => ({
          ownerName: d.ownerName || null,
          category: d.category,
          label: d.label || '',
          buildingName: d.buildingName || '',
          owed: _round(d.owed),
          paid: _round(d.paid),
          // D5: vacant-unit share routed to owner → frontend marks it ΚΕΝΟ.
          vacant: !!d.vacant,
          // Per-individual-owner € slices (name/%/€ incl. the synthetic «λοιποί»
          // remainder). WITHOUT this passthrough the overview's byOwnerRaw read
          // of `ln.owners` was always undefined → it fell back to keying by the
          // JOINED co-owner name (the ΑΝΑ ΙΔΙΟΚΤΗΤΗ "one owner per row" fix + the
          // ΛΟΙΠΟΙ naming were dead paths on the dashboard). Preserve the slices.
          owners: Array.isArray(d.owners) ? d.owners : undefined
        }))
        .filter((d) => d.owed > 0 || d.paid > 0)
        // largest owed first so the most significant lines lead the tooltip.
        .sort((a, b2) => b2.owed - a.owed)
    }));

  return {
    totalYearExpenses: _round(totalYearExpenses),
    totalYearPaid: _round(totalYearPaid),
    expenses,
    owedByBuildingId
  };
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

  // Get building names for grouping. Realm-scope the lookup as defense-in-
  // depth: bills are already realm-filtered above, but enforcing realmId
  // on the building fetch closes the door if a tampered bill.buildingId
  // ever pointed at another realm's building.
  const buildingIds = [...new Set(bills.map((b) => b.buildingId))];
  const buildings: AnyRecord[] = await Collections.Building.find(
    { realmId, _id: { $in: buildingIds } },
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

// ─────────────────────────────────────────────────────────────────────────
// GET /dashboard/overview/:year — the realm-wide ΕΠΙΣΚΟΠΗΣΗ page.
//
// DRIFT GUARANTEE (user's hard rule: "no inconsistent posa across tabs"):
// this handler performs NO new money arithmetic on actuals. It reuses the
// SAME functions the building pages + the main dashboard already use —
//   • income (collected/owed): the rent.total ledger fields, summed with the
//     SAME carry-forward strip the building A2 tile + dashboard use
//     (monthDue = grandTotal − max(0,balance); owed = max(0, monthDue − paid)),
//   • owner εκσοδα: computeOwnerEksodaByMonth (identical to the dashboard's
//     _expensesRollup, which is called here verbatim),
//   • year revenue: _computeTotalYearRevenues.
// It only AGGREGATES + SLICES those already-correct values per building / per
// owner / per category. Any figure on this page is therefore, by construction,
// the sum of figures already shown on the building/owner/dashboard surfaces.
//
// The PROJECTION (πραγμ.+εκτ.) is the one piece not yet a shared server fn —
// it mirrors BuildingDashboard.js's client formula (active-months-prorated
// recurring + fixed; 3-month-average × remaining for variable). It is DISPLAY
// ONLY and clearly separated ('estimate' fields), never summed into an actual.
// ─────────────────────────────────────────────────────────────────────────
export async function overview(req: Req, res: Res) {
  const realmId = req.realm!._id;
  // Year comes from the path; default to current. Validated by the route regex.
  const now = moment.utc();
  const year = Number(req.params.year) || now.year();
  const isCurrentYear = year === now.year();
  const currentMonthIdx = isCurrentYear ? now.month() + 1 : 12; // 1..12

  // ── Fetch tenants (rents for the requested year) ──
  const yearStr = String(year);
  const allTenants: AnyRecord[] = await Collections.Tenant.aggregate([
    { $match: { realmId } },
    {
      $project: {
        name: 1,
        firstName: 1,
        lastName: 1,
        beginDate: 1,
        terminationDate: 1,
        endDate: 1,
        'properties.propertyId': 1,
        rents: {
          $filter: {
            input: '$rents',
            as: 'r',
            cond: {
              $eq: [{ $substrBytes: [{ $toString: '$$r.term' }, 0, 4] }, yearStr]
            }
          }
        }
      }
    }
  ]);

  const buildings: AnyRecord[] = await Collections.Building.find({
    realmId
  }).lean();

  // ── Per-building income {collected, owed} — SAME carry-forward strip as
  //    buildingmanager rentYTDByBuilding + dashboard (documented above). ──
  const propIdToBuildingId = new Map<string, string>();
  for (const b of buildings) {
    for (const u of b.units || []) {
      if (u.propertyId)
        propIdToBuildingId.set(String(u.propertyId), String(b._id));
    }
  }
  const incomeByBuilding = new Map<string, { collected: number; owed: number }>();
  // Standalone tenants (property not inside any building) accumulate here so the
  // realm income headline stays === Σ(per-building + standalone) — Step-7 D2:
  // dropping them made the headline exceed the sum of the building rows.
  const standalone = { collected: 0, owed: 0 };
  // Per-tenant + arrears (this-month remaining owed, days overdue).
  const perTenant: AnyRecord[] = [];
  const arrears: AnyRecord[] = [];
  // Realm income is the SUM of the SAME per-tenant term-based figures used for
  // the per-building rows — NOT a separate payment-date revenue fn (Step-7 D1:
  // _computeTotalYearRevenues counts payments by date minus vat/deposit, which
  // could never equal Σ perBuilding.collected on the same screen). One axis, one
  // number, reconciles by construction.
  let incomeCollected = 0;
  let incomeOwed = 0;
  let chargesOnRentCollected = 0;
  // Per-MONTH-NUMBER (1..12) collected income for the cash-flow chart. Keyed by
  // the integer month so the client can render Jan→Dec in order (the MMYYYY
  // string keys sort integer-first: "10.."/"11.."/"12.." jump ahead of
  // "01..".."09.." — that mis-ordering is what put Oct/Nov/Dec's bars in the
  // Jan/Feb/Mar slots and left a fake gap Apr→Sep).
  const incomeByMonthNum = new Map<number, number>();
  for (const t of allTenants) {
    let bid: string | null = null;
    for (const tp of t.properties || []) {
      const cand = propIdToBuildingId.get(String(tp.propertyId));
      if (cand) {
        bid = cand;
        break;
      }
    }
    let collected = 0;
    let owed = 0;
    let latestArrear = 0;
    for (const rent of t.rents || []) {
      if (Math.floor(Number(rent.term || 0) / 1000000) !== year) continue;
      const grand = Number(rent?.total?.grandTotal) || 0;
      const payment = Number(rent?.total?.payment) || 0;
      const balance = Number(rent?.total?.balance) || 0;
      const monthDue = Math.max(0, grand - Math.max(0, balance));
      collected += payment;
      const termCharges = (rent.charges || []).reduce(
        (s: number, c: AnyRecord) => s + (Number(c?.amount) || 0),
        0
      );
      chargesOnRentCollected += termCharges;
      const monthOwed = Math.max(0, monthDue - payment);
      owed += monthOwed;
      const termMonth = Math.floor(Number(rent.term || 0) / 10000) % 100;
      if (payment > 0)
        incomeByMonthNum.set(
          termMonth,
          (incomeByMonthNum.get(termMonth) || 0) + payment
        );
      // Track the most-recent month's shortfall for the arrears list.
      if (termMonth <= currentMonthIdx && monthOwed > 0.005)
        latestArrear = monthOwed;
    }
    incomeCollected += collected;
    incomeOwed += owed;
    if (bid) {
      const slot = incomeByBuilding.get(bid) || { collected: 0, owed: 0 };
      slot.collected = _round(slot.collected + collected);
      slot.owed = _round(slot.owed + owed);
      incomeByBuilding.set(bid, slot);
    } else {
      standalone.collected = _round(standalone.collected + collected);
      standalone.owed = _round(standalone.owed + owed);
    }
    if (collected > 0 || owed > 0) {
      perTenant.push({
        name: _tenantName(t),
        collected: _round(collected),
        owed: _round(owed)
      });
    }
    if (latestArrear > 0.005) {
      arrears.push({ name: _tenantName(t), owed: _round(latestArrear) });
    }
  }
  incomeCollected = _round(incomeCollected);
  incomeOwed = _round(incomeOwed);

  // ── Annual projection (per-building, summed realm-wide) ──
  // Build the tenantsByPropertyId map from the already-fetched allTenants.
  // Each tenant may occupy multiple properties; each property gets a slot.
  const _tenantsByPropertyId = new Map<string, {
    rent: number;
    expenses: Array<{ amount?: number; beginDate?: string; endDate?: string }>;
    beginDate: string;
    endDate: string;
  }>();
  for (const t of allTenants) {
    for (const tp of (t as any).properties || []) {
      _tenantsByPropertyId.set(String(tp.propertyId), {
        rent: Number(tp.rent) || 0,
        expenses: tp.expenses || [],
        beginDate: (t as any).beginDate || '',
        endDate: (t as any).terminationDate || (t as any).endDate || ''
      });
    }
  }
  const _projNow = moment.utc();
  let projIncomeTotal = 0;
  let projIncomeProjected = 0;
  let projOwnerExpTotal = 0;
  let projOwnerExpProjected = 0;
  const projByBuildingId = new Map<string, { incomeProj: number; expProj: number }>();
  for (const b of buildings) {
    const r = BuildingProjection.computeBuildingProjection(
      b as any,
      _tenantsByPropertyId,
      year,
      _projNow
    );
    projIncomeTotal += r.annualIncome;
    projIncomeProjected += r.annualIncomeProjected;
    projOwnerExpTotal += r.annualOwnerExpenses;
    projOwnerExpProjected += r.annualOwnerExpensesProjected;
    projByBuildingId.set(String(b._id), {
      incomeProj: _round(r.annualIncome),
      expProj: _round(r.annualOwnerExpenses)
    });
  }
  projIncomeTotal = _round(projIncomeTotal);
  projIncomeProjected = _round(projIncomeProjected);
  projOwnerExpTotal = _round(projOwnerExpTotal);
  projOwnerExpProjected = _round(projOwnerExpProjected);

  // ── Owner εκσοδα rollup: reuse _expensesRollup (identical to the dashboard).
  //    Its expenses[].breakdown[] carries per-(ownerName, category, label,
  //    buildingName, vacant) lines — the raw material for every κατανομή. ──
  let expensesRollup = {
    totalYearExpenses: 0,
    totalYearPaid: 0,
    expenses: [] as AnyRecord[],
    owedByBuildingId: new Map<string, number>()
  };
  try {
    expensesRollup = await _expensesRollup(String(realmId), year);
  } catch (error) {
    logger.error(`overview: expenses rollup failed: ${String(error)}`);
  }
  // Per-building owner-εκσοδα comes from the SAME rollup (same term filter as
  // the headline total) — Step-7 D4: never re-sum owedByTerm separately.
  const ownerEksodaByBuildingId = expensesRollup.owedByBuildingId;

  // Flatten breakdown lines across all months → κατανομές by category /
  // label / owner (each summed over the year). Accumulate WITHOUT per-add
  // rounding, round once at the end, so every κατανομή reconciles to
  // totals.ownerExpenses to the cent. Step-7 D3: a line with no named owner is
  // NOT dropped — it folds into an «(αδιάθετο)» bucket so byOwner still sums to
  // the total. buildingName is NOT keyed here (Step-7 D4: two buildings can
  // share a name); per-building εκσοδα is computed per-_id below instead.
  const UNASSIGNED_OWNER = t_unassignedOwnerLabel();
  // «Λοιποί ιδιοκτήτες» — the shared label for the un-named co-owner remainder
  // (same string as the owner-ledger placeholder, common/ownerstatement.
  // LOIPOI_LABEL) so ΑΝΑ ΙΔΙΟΚΤΗΤΗ names it identically to the owner list.
  const LOIPOI_OWNER = OwnerStatement.LOIPOI_LABEL;
  const byCategoryRaw = new Map<string, number>();
  const byLabelRaw = new Map<string, number>();
  const byOwnerRaw = new Map<string, number>();
  for (const m of expensesRollup.expenses) {
    for (const ln of (m.breakdown as AnyRecord[]) || []) {
      const owed = Number(ln.owed) || 0;
      if (!(owed > 0)) continue;
      byCategoryRaw.set(ln.category, (byCategoryRaw.get(ln.category) || 0) + owed);
      const lbl = ln.label || ln.category;
      byLabelRaw.set(lbl, (byLabelRaw.get(lbl) || 0) + owed);
      // ΑΝΑ ΙΔΙΟΚΤΗΤΗ must be per INDIVIDUAL owner (one row each), not per joined
      // co-owner name. A co-owned line carries `owners[]` slices (name/%/€ incl. a
      // synthetic «λοιποί» remainder); accumulate each owner's own € slice so the
      // same owner never appears in two rows. Fall back to the whole line's
      // ownerName only when there are no slices (single-owner line).
      const slices = Array.isArray(ln.owners) ? ln.owners : [];
      if (slices.length) {
        for (const s of slices) {
          // An un-named co-owner remainder (isRest) is a real «Λοιποί
          // ιδιοκτήτες» liability, NOT «Αδιάθετο» — matching the owner ledger,
          // which routes the same rest slice to the ΛΟΙΠΟΙ placeholder. This is
          // what makes ΑΝΑ ΙΔΙΟΚΤΗΤΗ reconcile with the eksoda total (the
          // remainder was counted in the total here but dropped by the ledger).
          const nm = s?.isRest ? LOIPOI_OWNER : s?.name || UNASSIGNED_OWNER;
          byOwnerRaw.set(nm, (byOwnerRaw.get(nm) || 0) + (Number(s?.amount) || 0));
        }
      } else {
        const owner = ln.ownerName || UNASSIGNED_OWNER;
        byOwnerRaw.set(owner, (byOwnerRaw.get(owner) || 0) + owed);
      }
    }
  }

  // ── Repairs: status counts (realm) + cost per building. (Owner-εκσοδα per
  //    building already came from expensesRollup.owedByBuildingId above — no
  //    second computeOwnerEksodaByMonth pass.) ──
  const repairStatus = { planned: 0, inProgress: 0, emergencies: 0 };
  const repairCostByBuilding: Array<{ name: string; cost: number; count: number }> = [];
  for (const b of buildings) {
    let rCost = 0;
    let rCount = 0;
    for (const r of b.repairs || []) {
      if (r.status === 'planned') repairStatus.planned++;
      else if (r.status === 'in_progress') repairStatus.inProgress++;
      if (r.urgency === 'emergency' && r.status !== 'completed' && r.status !== 'cancelled')
        repairStatus.emergencies++;
      const cost = Number(r.actualCost) || Number(r.estimatedCost) || 0;
      if (cost > 0) {
        rCost += cost;
        rCount += 1;
      }
    }
    if (rCost > 0)
      repairCostByBuilding.push({ name: b.name || '', cost: _round(rCost), count: rCount });
  }
  repairCostByBuilding.sort((a, b2) => b2.cost - a.cost);

  // ── Assemble per-building rows (income by _id + owner εκσοδα by _id + net).
  //    Includes a standalone (building-less) row when it carries money so
  //    Σ rows === realm totals (Step-7 D2). ──
  const perBuilding = buildings.map((b) => {
    const inc = incomeByBuilding.get(String(b._id)) || { collected: 0, owed: 0 };
    const eks = ownerEksodaByBuildingId.get(String(b._id)) || 0;
    const proj = projByBuildingId.get(String(b._id)) || { incomeProj: 0, expProj: 0 };
    return {
      buildingId: String(b._id),
      name: b.name || '',
      collected: inc.collected,
      collectedProjected: proj.incomeProj,
      ownerExpenses: _round(eks),
      ownerExpensesProjected: proj.expProj,
      net: _round(inc.collected - eks),
      netProjected: _round(proj.incomeProj - proj.expProj)
    };
  });
  if (standalone.collected > 0 || standalone.owed > 0) {
    perBuilding.push({
      buildingId: '',
      name: t_standaloneLabel(),
      collected: standalone.collected,
      collectedProjected: standalone.collected,
      ownerExpenses: 0,
      ownerExpensesProjected: 0,
      net: standalone.collected,
      netProjected: standalone.collected
    });
  }

  // ── Per-owner income attribution: tenant payment → property → unit → owners.
  //    Split each tenant's payment proportionally across their properties (by
  //    each property's share of grandTotal), then per unit-owner by %.
  //    BaseRent-only (excl. δαπάνες) tracked separately for the tax calc. ──
  const propIdToOwners = new Map<string, Array<{ name: string; percentage: number }>>();
  for (const b of buildings) {
    for (const u of (b.units || []) as AnyRecord[]) {
      const pid = String(u.propertyId || '');
      if (!pid) continue;
      const owners = (u.owners || []).map((o: AnyRecord) => ({
        name: String(o.name || ''),
        percentage: Math.min(100, Math.max(0, Number(o.percentage) || 0))
      }));
      if (owners.length) propIdToOwners.set(pid, owners);
    }
  }

  const incomeByOwner = new Map<string, number>();
  const baseRentByOwner = new Map<string, number>();

  for (const t of allTenants) {
    const tenantProps = t.properties || [];
    for (const rent of t.rents || []) {
      if (Math.floor(Number(rent.term || 0) / 1000000) !== year) continue;
      const payment = Number(rent?.total?.payment) || 0;
      if (payment <= 0) continue;

      // Per-property share of this term's billed total (for proportional split).
      // 1_base.ts pushes charges[] per-property in the same order as the
      // tenant.properties[] array — one slice of charges per property, sized by
      // the number of expenses on that property. Track offset as we iterate.
      const preTaxArr = rent.preTaxAmounts || [];
      const chargesArr = rent.charges || [];
      const perPropBill: Array<{ propertyId: string; baseRent: number; total: number }> = [];
      let billSum = 0;
      let chargeOffset = 0;
      for (let i = 0; i < tenantProps.length; i++) {
        const pid = String(tenantProps[i]?.propertyId || '');
        const base = Number(preTaxArr[i]?.amount) || 0;
        const propExpCount = (tenantProps[i]?.expenses || []).length;
        let chargeSum = 0;
        for (let ci = chargeOffset; ci < chargeOffset + propExpCount && ci < chargesArr.length; ci++) {
          chargeSum += Number(chargesArr[ci]?.amount) || 0;
        }
        chargeOffset += propExpCount;
        const total = base + chargeSum;
        perPropBill.push({ propertyId: pid, baseRent: base, total });
        billSum += total;
      }
      if (billSum <= 0) continue;

      // Distribute the payment proportionally, then split per owner
      for (const pp of perPropBill) {
        const propShare = payment * (pp.total / billSum);
        const baseRentShare = payment * (pp.baseRent / billSum);
        const owners = propIdToOwners.get(pp.propertyId);
        if (!owners || !owners.length) {
          // Standalone property (no building unit) — attribute to «αδιάθετο»
          const key = UNASSIGNED_OWNER;
          incomeByOwner.set(key, (incomeByOwner.get(key) || 0) + propShare);
          baseRentByOwner.set(key, (baseRentByOwner.get(key) || 0) + baseRentShare);
          continue;
        }
        const pctSum = owners.reduce((s, o) => s + o.percentage, 0) || 100;
        for (const o of owners) {
          const frac = o.percentage / pctSum;
          const ownerInc = propShare * frac;
          const ownerBase = baseRentShare * frac;
          const nm = o.name || UNASSIGNED_OWNER;
          incomeByOwner.set(nm, (incomeByOwner.get(nm) || 0) + ownerInc);
          baseRentByOwner.set(nm, (baseRentByOwner.get(nm) || 0) + ownerBase);
        }
      }
    }
  }

  // ── Tax computation per owner (art. 40 par. 4 ΚΦΕ, year-keyed). ──
  function _rentalIncomeTax(grossBaseRent: number, fiscalYear: number): number {
    const taxable = grossBaseRent * 0.95; // 5% deemed deduction
    if (fiscalYear >= 2026) {
      // N.5246/2025: 15% ≤12k, 25% ≤24k, 35% ≤36k, 45% above
      if (taxable <= 12000) return _round(taxable * 0.15);
      if (taxable <= 24000) return _round(1800 + (taxable - 12000) * 0.25);
      if (taxable <= 36000) return _round(1800 + 3000 + (taxable - 24000) * 0.35);
      return _round(1800 + 3000 + 4200 + (taxable - 36000) * 0.45);
    }
    // ≤2025: 15% ≤12k, 35% ≤35k, 45% above
    if (taxable <= 12000) return _round(taxable * 0.15);
    if (taxable <= 35000) return _round(1800 + (taxable - 12000) * 0.35);
    return _round(1800 + 8050 + (taxable - 35000) * 0.45);
  }

  // ── Per-owner income projection (from buildingprojection results). ──
  //    projIncomeTotal/projIncomeProjected are realm-wide. To split per-owner
  //    we prorate by each owner's share of actual income (same attribution
  //    logic). For owners with zero actuals, projection = 0 (no lease active).
  const totalActualIncome = [...incomeByOwner.values()].reduce((s, v) => s + v, 0) || 1;

  // ── Assemble perOwner with all columns ──
  const allOwnerNames = new Set([...byOwnerRaw.keys(), ...incomeByOwner.keys()]);
  const perOwner = [...allOwnerNames]
    .map((ownerName) => {
      const income = _round(incomeByOwner.get(ownerName) || 0);
      const baseRent = baseRentByOwner.get(ownerName) || 0;
      const ownerExpenses = _round(byOwnerRaw.get(ownerName) || 0);
      const tax = _rentalIncomeTax(baseRent, year);
      const net = _round(income - ownerExpenses - tax);
      // Projection: prorate the realm-wide projected figures by this owner's
      // share of actual income.
      const incFrac = income / totalActualIncome;
      const incomeProjected = _round(projIncomeProjected * incFrac);
      const expFrac = ownerExpenses / (expensesRollup.totalYearExpenses || 1);
      const ownerExpensesProjected = _round(projOwnerExpProjected * expFrac);
      const baseRentProjected = baseRent + (projIncomeProjected * incFrac * (baseRent / (income || 1)));
      const taxProjected = _rentalIncomeTax(baseRentProjected, year);
      const netProjected = _round(
        (income + incomeProjected) - (ownerExpenses + ownerExpensesProjected) - taxProjected
      );
      return {
        ownerName,
        income,
        incomeProjected: _round(income + incomeProjected),
        ownerExpenses,
        ownerExpensesProjected: _round(ownerExpenses + ownerExpensesProjected),
        tax,
        taxProjected,
        net,
        netProjected
      };
    })
    .sort((a, b) => b.income - a.income);

  const toSortedArr = (m: Map<string, number>) =>
    Array.from(m.entries())
      .map(([label, amount]) => ({ label, amount: _round(amount) }))
      .sort((a, b) => b.amount - a.amount);

  res.json({
    year,
    isCurrentYear,
    // ACTUALS — every figure reconciles by construction (Step-7 D1/D2/D3/D4):
    //  income  = Σ per-tenant term-based collected = Σ(perBuilding+standalone)
    //  εκσοδα  = _expensesRollup owed = Σ per-building eksoda = Σ κατανομές
    totals: {
      income: incomeCollected,
      incomeOwed,
      chargesOnRent: _round(chargesOnRentCollected),
      ownerExpenses: _round(expensesRollup.totalYearExpenses),
      ownerExpensesPaid: _round(expensesRollup.totalYearPaid),
      net: _round(incomeCollected - expensesRollup.totalYearExpenses),
      projection: {
        income: projIncomeTotal,
        incomeEstimate: projIncomeProjected,
        ownerExpenses: projOwnerExpTotal,
        ownerExpensesEstimate: projOwnerExpProjected
      }
    },
    // Ordered Jan→Dec (month 1..12). Parses each MMYYYY key's leading MM so the
    // client renders in calendar order regardless of object-key iteration order
    // (the fake Apr→Sep gap was integer-key sort of "10.."/"11.."/"12.."). Each
    // slot carries income (collected) AND expense (owed) so it's a real cash-flow.
    monthly: (() => {
      const expByNum = new Map<number, number>();
      for (const m of expensesRollup.expenses) {
        const mn = Number(String(m.month).slice(0, 2)); // "MMYYYY" → MM
        expByNum.set(mn, (m.notPaid || 0) + (m.paid || 0));
      }
      return Array.from({ length: 12 }, (_v, i) => {
        const mn = i + 1;
        return {
          month: mn,
          income: _round(incomeByMonthNum.get(mn) || 0),
          expense: _round(expByNum.get(mn) || 0)
        };
      });
    })(),
    perBuilding,
    perOwner,
    katanomes: {
      byCategory: toSortedArr(byCategoryRaw),
      byLabel: toSortedArr(byLabelRaw).slice(0, 8),
      // εκσοδα per building keyed by _id → name (Step-7 D4: name is not unique;
      // two same-named buildings stay distinct rows/slices here).
      byBuilding: perBuilding
        .filter((b) => b.buildingId && b.ownerExpenses > 0)
        .map((b) => ({ label: b.name, amount: b.ownerExpenses }))
        .sort((a, b) => b.amount - a.amount),
      byOwner: toSortedArr(byOwnerRaw)
    },
    arrears: arrears.sort((a, b) => b.owed - a.owed).slice(0, 10),
    repairs: {
      status: repairStatus,
      byBuilding: repairCostByBuilding
    }
  });
}

// Labels for the two synthetic buckets (kept out of i18n JSON churn; the API
// returns display text directly, matching how ownerName/buildingName are
// returned as text elsewhere in this payload).
function t_unassignedOwnerLabel(): string {
  return 'Αδιάθετο';
}
function t_standaloneLabel(): string {
  return 'Χωρίς κτίριο';
}
