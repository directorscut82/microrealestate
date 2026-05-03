import { Collections } from '@microrealestate/common';
import type { ServiceRequest, ServiceResponse } from '@microrealestate/types';
import moment from 'moment';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = ServiceRequest<any, any, any>;
type Res = ServiceResponse;
type AnyRecord = Record<string, any>;

export async function all(req: Req, res: Res) {
  const now = moment();
  const beginOfTheMonth = moment(now).startOf('month');
  const endOfTheMonth = moment(now).endOf('month');
  const beginOfTheYear = moment(now).startOf('year');
  const endOfTheYear = moment(now).endOf('year');

  const allTenants: AnyRecord[] = await Collections.Tenant.find({
    realmId: req.headers.organizationid
  });
  const activeTenants = allTenants.reduce((acc: AnyRecord[], tenant: AnyRecord) => {
    const terminationMoment = tenant.terminationDate
      ? moment(tenant.terminationDate)
      : moment(tenant.endDate);

    if (terminationMoment.isSameOrAfter(now, 'day')) {
      acc.push(tenant);
    }

    return acc;
  }, []);
  const tenantCount = activeTenants.length;

  const propertyCount = await Collections.Property.find({
    realmId: req.headers.organizationid
  }).count();

  let occupancyRate: number | undefined;
  if (propertyCount > 0) {
    const countPropertyRented = activeTenants.reduce(
      (acc: Set<string>, { properties = [] }: AnyRecord) => {
        properties.forEach(({ propertyId }: AnyRecord) => acc.add(propertyId));
        return acc;
      },
      new Set<string>()
    ).size;
    occupancyRate = countPropertyRented / propertyCount;
  }

  let totalYearRevenues = 0;

  if (allTenants.length > 0) {
    totalYearRevenues = allTenants.reduce((total: number, { rents = [] }: AnyRecord) => {
      let sumPayments = 0;
      rents.forEach((rent: AnyRecord) => {
        (rent.payments || []).forEach((payment: AnyRecord) => {
          if (!payment.date || payment.amount === 0) {
            return;
          }

          const paymentMoment = moment(payment.date, 'DD/MM/YYYY');
          if (
            paymentMoment.isBetween(beginOfTheYear, endOfTheYear, 'day', '[]')
          ) {
            sumPayments = sumPayments + payment.amount;
          }
        });
      });

      return total + sumPayments;
    }, 0);
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
            const currentRent = (tenant.rents || []).find((rent: AnyRecord) => {
              const termMoment = rent.term && moment(rent.term, 'YYYYMMDDHH');
              return (
                termMoment &&
                termMoment.isBetween(
                  beginOfTheMonth,
                  endOfTheMonth,
                  'day',
                  '[]'
                )
              );
            });
            if (currentRent) {
              acc.push({
                tenant: tenant.toObject ? tenant.toObject() : tenant,
                balance:
                  (currentRent.total?.payment || 0) - (currentRent.total?.grandTotal || 0),
                rent: currentRent
              });
            }
            return acc;
          }, [])
          .sort((t1: AnyRecord, t2: AnyRecord) => t1.balance - t2.balance)
          .filter((t: AnyRecord) => t.balance < 0)
          .slice(0, 5)
      : [];

  const emptyRevenues = moment.months().reduce((acc: AnyRecord, _month: string, index: number) => {
    const key = moment(`${index + 1}/${now.year()}`, 'MM/YYYY').format(
      'MMYYYY'
    );
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
      const tenantName = tenant.name || `${tenant.firstName || ''} ${tenant.lastName || ''}`.trim();
      (tenant.rents || []).forEach((rent: AnyRecord) => {
        const termMoment = moment(rent.term, 'YYYYMMDDHH');
        if (!termMoment.isBetween(beginOfTheYear, endOfTheYear, 'day', '[]')) {
          return;
        }
        const key = termMoment.format('MMYYYY');

        const tenantBaseRent = rent.total?.preTaxAmount || 0;
        const tenantCharges = (rent.charges || []).reduce(
          (sum: number, c: AnyRecord) => sum + (c.amount || 0), 0
        );
        const tenantBuildingCharges = (rent.buildingCharges || []).reduce(
          (sum: number, c: AnyRecord) => sum + (c.amount || 0), 0
        );
        const tenantBuildingByType: AnyRecord = {};
        (rent.buildingCharges || []).forEach((c: AnyRecord) => {
          const t = c.type || 'other';
          tenantBuildingByType[t] = (tenantBuildingByType[t] || 0) + (c.amount || 0);
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
        acc[key].notPaid += tenantPaid - tenantDue < 0 ? tenantPaid - tenantDue : 0;
        acc[key].baseRent += tenantBaseRent;
        acc[key].charges += tenantCharges;
        acc[key].buildingCharges += tenantBuildingCharges;
        Object.entries(tenantBuildingByType).forEach(([type, amount]) => {
          acc[key].buildingChargesByType[type] = (acc[key].buildingChargesByType[type] || 0) + (amount as number);
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
      paid: (value as AnyRecord).paid > 0
        ? Math.round((value as AnyRecord).paid * 100) / 100
        : (value as AnyRecord).paid,
      notPaid: (value as AnyRecord).notPaid < 0
        ? Math.round((value as AnyRecord).notPaid * 100) / 100
        : (value as AnyRecord).notPaid
    }))
    .sort((r1: AnyRecord, r2: AnyRecord) =>
      moment(r1.month, 'MMYYYY').isBefore(moment(r2.month, 'MMYYYY')) ? -1 : 1
    );

  res.json({
    overview,
    topUnpaid,
    revenues
  });
}
