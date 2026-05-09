import { Collections, logger } from '@microrealestate/common';
import type { ServiceRequest, ServiceResponse } from '@microrealestate/types';
import moment from 'moment';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = ServiceRequest<any, any, any>;
type Res = ServiceResponse;
type AnyRecord = Record<string, any>;

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

  const propertyCount = await Collections.Property.countDocuments({
    realmId
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
              const balance =
                (currentRent.total?.payment || 0) -
                (currentRent.total?.grandTotal || 0);
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
        acc[key].notPaid +=
          tenantPaid - tenantDue < 0 ? tenantPaid - tenantDue : 0;
        acc[key].baseRent += tenantBaseRent;
        acc[key].charges += tenantCharges;
        acc[key].buildingCharges += tenantBuildingCharges;
        Object.entries(tenantBuildingByType).forEach(([type, amount]) => {
          acc[key].buildingChargesByType[type] =
            (acc[key].buildingChargesByType[type] || 0) + (amount as number);
        });
        acc[key].tenants.push({
          name: tenantName,
          paid: tenantPaid,
          due: tenantDue,
          baseRent: tenantBaseRent,
          charges: tenantCharges,
          buildingCharges: tenantBuildingCharges,
          buildingChargesByType: tenantBuildingByType
        });
      });
      return acc;
    }, emptyRevenues)
  )
    .map(([, value]) => ({
      ...(value as AnyRecord),
      paid:
        (value as AnyRecord).paid > 0
          ? Math.round((value as AnyRecord).paid * 100) / 100
          : (value as AnyRecord).paid,
      notPaid:
        (value as AnyRecord).notPaid < 0
          ? Math.round((value as AnyRecord).notPaid * 100) / 100
          : (value as AnyRecord).notPaid
    }))
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
