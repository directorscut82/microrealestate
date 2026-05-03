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
      notPaid: 0
    };
    return acc;
  }, {});
  const revenues = Object.entries(
    allTenants.reduce((acc: AnyRecord, { rents = [] }: AnyRecord) => {
      rents.forEach((rent: AnyRecord) => {
        const termMoment = moment(rent.term, 'YYYYMMDDHH');
        if (!termMoment.isBetween(beginOfTheYear, endOfTheYear, 'day', '[]')) {
          return;
        }
        const key = termMoment.format('MMYYYY');
        const revenue = {
          month: key,
          paid: rent.total?.payment || 0,
          notPaid:
            (rent.total?.payment || 0) - (rent.total?.grandTotal || 0) < 0
              ? (rent.total?.payment || 0) - (rent.total?.grandTotal || 0)
              : 0,
          baseRent: rent.total?.preTaxAmount || 0,
          charges: (rent.charges || []).reduce(
            (sum: number, c: AnyRecord) => sum + (c.amount || 0), 0
          ),
          buildingCharges: (rent.buildingCharges || []).reduce(
            (sum: number, c: AnyRecord) => sum + (c.amount || 0),
            0
          )
        };
        if (acc[key]) {
          acc[key].paid += revenue.paid;
          acc[key].notPaid += revenue.notPaid;
          acc[key].baseRent += revenue.baseRent;
          acc[key].charges += revenue.charges;
          acc[key].buildingCharges += revenue.buildingCharges;
        } else {
          acc[key] = revenue;
        }
      });
      return acc;
    }, emptyRevenues)
  )
    .map(([, value]) => ({
      ...(value as AnyRecord),
      paid: (value as AnyRecord).paid > 0 ? Math.round((value as AnyRecord).paid * 100) / 100 : (value as AnyRecord).paid,
      notPaid:
        (value as AnyRecord).notPaid < 0
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
