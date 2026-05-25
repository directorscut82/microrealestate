import type { CollectionTypes } from '@microrealestate/types';
import moment from 'moment';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

// Wave-17 B3: compute, for a given target term, whether the running
// cumulative balance through that term has been settled by a later
// payment. Walks rents in chronological order, accumulating
// (monthlyBill - paymentForThisRent) deltas. The target term is
// "settled-via-carryforward" iff there exists some term >= target where
// the cumulative balance is at or below the rounding tolerance.
//
// IMPORTANT: rent.total.grandTotal already includes the carried
// rent.total.balance from the prior month (see businesslogic/tasks/7_total.ts).
// Using grandTotal directly here would double-count the carry-in. The
// per-month bill is therefore (grandTotal - balance), which we feed into
// the running sum so each term contributes its OWN charges and payments
// exactly once.
function _isSettledByCarryForward(
  targetTerm: number,
  allRents: AnyRecord[]
): boolean {
  if (!Array.isArray(allRents) || allRents.length === 0) return false;
  const sorted = [...allRents].sort(
    (a, b) => Number(a.term) - Number(b.term)
  );
  let running = 0;
  let reachedTarget = false;
  for (const r of sorted) {
    const grandTotal = Number(r?.total?.grandTotal) || 0;
    const carryIn = Number(r?.total?.balance) || 0;
    const monthlyBill = grandTotal - carryIn;
    const paymentsSum = (r.payments || []).reduce(
      (s: number, p: AnyRecord) => s + (Number(p.amount) || 0),
      0
    );
    const settlementDiscounts = (r.discounts || [])
      .filter((d: AnyRecord) => d.origin === 'settlement')
      .reduce((s: number, d: AnyRecord) => s + (Number(d.amount) || 0), 0);
    const cashIn = paymentsSum + settlementDiscounts;
    running += monthlyBill - cashIn;
    if (Number(r.term) === Number(targetTerm)) {
      reachedTarget = true;
    }
    if (reachedTarget && running <= 0.01) {
      return true;
    }
  }
  return false;
}

export function toRentData(
  inputRent: AnyRecord,
  inputOccupant?: AnyRecord,
  emailStatus?: AnyRecord,
  allRents?: AnyRecord[]
): AnyRecord {
  const rent: AnyRecord = JSON.parse(JSON.stringify(inputRent));

  const rentToReturn: AnyRecord = {
    month: rent.month,
    year: rent.year,
    term: rent.term,
    balance: rent.total.balance,
    newBalance: rent.total.payment - rent.total.grandTotal,
    hasMultiplePayments: !!(rent.payments && rent.payments.length > 1),
    payment: rent.total.payment || 0,
    payments: rent.payments,
    discount: rent.total.discount,
    totalAmount: rent.total.grandTotal,
    totalWithoutBalanceAmount: rent.total.grandTotal - rent.total.balance,
    totalToPay: rent.total.grandTotal,
    description: rent.description,
    countMonthNotPaid: 0,
    paymentStatus: [] as AnyRecord[],
    preTaxAmounts: rent.preTaxAmounts || [],
    charges: rent.charges || [],
    buildingCharges: rent.buildingCharges || [],
    discounts: rent.discounts || [],
    debts: rent.debts || []
  };

  Object.assign(
    rentToReturn,
    rent.discounts
      .filter((discount: AnyRecord) => discount.origin === 'settlement')
      .reduce(
        (acc: AnyRecord, discount: AnyRecord) => {
          return {
            promo: acc.promo + discount.amount,
            notepromo: `${acc.notepromo}${discount.description}\n`
          };
        },
        { promo: 0, notepromo: '' }
      )
  );

  Object.assign(
    rentToReturn,
    rent.debts.reduce(
      (acc: AnyRecord, debt: AnyRecord) => {
        return {
          extracharge: acc.extracharge + debt.amount,
          noteextracharge: `${acc.noteextracharge}${debt.description}\n`
        };
      },
      { extracharge: 0, noteextracharge: '' }
    )
  );

  // Storage convention: promo and extracharge are stored net-of-VAT in
  // rentmanager.ts (divided by (1+vatRate)). Display convention here:
  // multiply back to gross for the UI. Net effect for promo is correct
  // because task 4 adds a settlement-VAT line (-net*vat) so grandTotal
  // moves by -original_promo. For extracharge there's no symmetric VAT
  // line (debts skip VAT in task 4) so the display value matches what
  // the user entered but the actual grandTotal increment is
  // extra/(1+vat). Known imbalance — see rentmanager.ts comment.
  // We safely read the contract VAT rate via filter+[0] to avoid
  // crashing when only settlement VAT lines exist (rent.vats[0] may
  // not be the contract one).
  const contractVat = (rent.vats || []).filter(
    (vat: AnyRecord) => vat.origin === 'contract'
  )[0];
  const vatRate = contractVat?.rate ?? 0;

  Object.assign(
    rentToReturn,
    rent.discounts
      .filter((discount: AnyRecord) => discount.origin === 'contract')
      .reduce(
        (acc: AnyRecord, discount: AnyRecord) => {
          return {
            totalWithoutVatAmount: acc.totalWithoutVatAmount - discount.amount
          };
        },
        { totalWithoutVatAmount: rent.total.preTaxAmount + rent.total.charges }
      )
  );

  Object.assign(
    rentToReturn,
    rent.vats
      .filter((vat: AnyRecord) => vat.origin === 'contract')
      .reduce(
        (acc: AnyRecord, vat: AnyRecord) => {
          return {
            vatAmount: acc.vatAmount + vat.amount
          };
        },
        { vatAmount: 0 }
      )
  );

  // Display gross-of-VAT: rentmanager stores net-of-VAT, we multiply back.
  if (vatRate) {
    if (rentToReturn.promo > 0) {
      rentToReturn.promo =
        Math.round(rentToReturn.promo * (1 + vatRate) * 100) / 100;
    }
    if (rentToReturn.extracharge > 0) {
      rentToReturn.extracharge =
        Math.round(rentToReturn.extracharge * (1 + vatRate) * 100) / 100;
    }
  }

  // payment status
  // Wave-17 B4: status was previously gated on `isSameOrBefore(now, 'month')`
  // which left every future-dated rent with status='' — even fully prepaid
  // months. The UI ledger then renders an empty status column instead of
  // "paid" / "notpaid". Assign status for every rent regardless of position
  // relative to today; prepayments are reflected as 'paid', upcoming-but-
  // unpaid as 'notpaid'. The legacy gate had no other purpose (all consumers
  // already tolerate the three-value enum).
  //
  // Wave-17 B3: when caller passes the FULL ledger as `allRents`, promote a
  // partiallypaid (or notpaid) past rent to 'paid' as soon as a later term's
  // payment has closed the running cumulative deficit. Without `allRents` we
  // fall back to per-term newBalance only (legacy behaviour, used by code
  // paths that don't yet plumb the ledger).
  if (rentToReturn.totalAmount <= 0 || rentToReturn.newBalance >= 0) {
    rentToReturn.status = 'paid';
  } else if (
    allRents &&
    _isSettledByCarryForward(Number(rentToReturn.term), allRents)
  ) {
    rentToReturn.status = 'paid';
  } else if (rentToReturn.payment > 0) {
    rentToReturn.status = 'partiallypaid';
  } else {
    rentToReturn.status = 'notpaid';
  }

  if (inputOccupant) {
    if (emailStatus) {
      const computedEmailStatus: AnyRecord = {
        status: {
          rentcall: !!(emailStatus.rentcall && emailStatus.rentcall.length),
          rentcall_reminder: !!(
            emailStatus.rentcall_reminder &&
            emailStatus.rentcall_reminder.length
          ),
          rentcall_last_reminder: !!(
            emailStatus.rentcall_last_reminder &&
            emailStatus.rentcall_last_reminder.length
          ),
          invoice: !!(emailStatus.invoice && emailStatus.invoice.length)
        },
        last: {
          rentcall:
            (emailStatus.rentcall &&
              emailStatus.rentcall.length &&
              emailStatus.rentcall[0]) ||
            undefined,
          rentcall_reminder:
            (emailStatus.rentcall_reminder &&
              emailStatus.rentcall_reminder.length &&
              emailStatus.rentcall_reminder[0]) ||
            undefined,
          rentcall_last_reminder:
            (emailStatus.rentcall_last_reminder &&
              emailStatus.rentcall_last_reminder.length &&
              emailStatus.rentcall_last_reminder[0]) ||
            undefined,
          invoice:
            (emailStatus.invoice &&
              emailStatus.invoice.length &&
              emailStatus.invoice[0]) ||
            undefined
        },
        count: {
          rentcall: (emailStatus.rentcall && emailStatus.rentcall.length) || 0,
          rentcall_reminder:
            (emailStatus.rentcall_reminder &&
              emailStatus.rentcall_reminder.length) ||
            0,
          rentcall_last_reminder:
            (emailStatus.rentcall_last_reminder &&
              emailStatus.rentcall_last_reminder.length) ||
            0,
          get allRentcall() {
            return (
              this.rentcall +
              this.rentcall_reminder +
              this.rentcall_last_reminder
            );
          },
          invoice: (emailStatus.invoice && emailStatus.invoice.length) || 0
        },
        ...emailStatus
      };

      Object.assign(rentToReturn, { emailStatus: computedEmailStatus });
    }

    const occupant = toOccupantData(inputOccupant);

    Object.assign(rentToReturn, {
      _id: occupant._id,
      occupant: occupant,
      vatRatio: occupant.vatRatio,
      uid: `${occupant._id}|${rent.month}|${rent.year}`
    });

    // count number of month rent not paid
    let endCounting = false;
    inputOccupant.rents
      .reverse()
      .filter((currentRent: AnyRecord) => {
        if (
          moment.utc(String(currentRent.term), 'YYYYMMDDHH').isSameOrBefore(
            moment.utc(),
            'month'
          )
        ) {
          if (endCounting) {
            return false;
          }

          const { grandTotal, payment } = currentRent.total;
          const newBalance = payment - grandTotal;

          if (grandTotal <= 0 || newBalance >= 0) {
            endCounting = true;
            return false;
          }

          if (payment > 0) {
            endCounting = true;
          }

          return true;
        }
        return false;
      })
      .reverse()
      .forEach((currentRent: AnyRecord) => {
        const payment = currentRent.total.payment;
        const term = moment.utc(String(currentRent.term), 'YYYYMMDDHH');
        rentToReturn.paymentStatus.push({
          month: term.month() + 1,
          status: payment > 0 ? 'partiallypaid' : 'notpaid'
        });
        rentToReturn.countMonthNotPaid++;
      });
  }

  return rentToReturn;
}

export function toOccupantData(inputOccupant: AnyRecord): AnyRecord {
  const occupant: AnyRecord = JSON.parse(JSON.stringify(inputOccupant));

  Object.assign(occupant, {
    beginDate: moment.utc(occupant.beginDate).format('DD/MM/YYYY'),
    endDate: moment.utc(occupant.endDate).format('DD/MM/YYYY'),
    frequency: occupant.frequency || 'months',
    street1: occupant.street1 || '',
    street2: occupant.street2 || '',
    zipCode: occupant.zipCode || '',
    city: occupant.city || '',
    country: occupant.country || '',
    legalForm: occupant.legalForm || '',
    siret: occupant.siret || '',
    contract: occupant.contract || '',
    reference: occupant.reference || '',
    guaranty: occupant.guaranty ? Number(occupant.guaranty) : 0,
    vatRatio: occupant.vatRatio ? Number(occupant.vatRatio) : 0,
    discount: occupant.discount ? Number(occupant.discount) : 0,
    rental: 0,
    expenses: 0,
    total: 0
  });

  if (occupant.terminationDate) {
    occupant.terminationDate = moment.utc(occupant.terminationDate).format(
      'DD/MM/YYYY'
    );
  }

  occupant.contactEmails =
    occupant.contacts && occupant.contacts.length
      ? occupant.contacts.reduce(
          (acc: string[], { email }: { email?: string }) => {
            if (email) {
              return [...acc, email.toLowerCase()];
            }
            return acc;
          },
          []
        )
      : [];

  occupant.hasContactEmails = occupant.contactEmails.length > 0;

  occupant.status = 'inprogress';
  occupant.terminated = false;
  const currentDate = moment.utc();
  const endMoment = moment.utc(
    occupant.terminationDate || occupant.endDate,
    'DD/MM/YYYY'
  );
  if (endMoment.isBefore(currentDate, 'day')) {
    occupant.terminated = true;
    occupant.status = 'stopped';
  }

  if (occupant.leaseId) {
    occupant.lease = occupant.leaseId;
    occupant.leaseId = occupant.leaseId._id;
  }

  if (occupant.properties) {
    occupant.office = {
      surface: 0,
      price: 0
    };
    occupant.parking = {
      price: 0
    };
    occupant.properties.forEach((item: AnyRecord) => {
      if (item.propertyId?._id) {
        item.property = item.property || item.propertyId;
        item.propertyId = item.propertyId._id;
      }
      if (item.property) {
        if (item.entryDate) {
          item.entryDate = moment.utc(item.entryDate).format('DD/MM/YYYY');
        }
        if (item.exitDate) {
          item.exitDate = moment.utc(item.exitDate).format('DD/MM/YYYY');
        }
        item.expenses.forEach((expense: AnyRecord) => {
          expense.beginDate = expense.beginDate
            ? moment.utc(expense.beginDate).format('DD/MM/YYYY')
            : item.entryDate;
          expense.endDate = expense.endDate
            ? moment.utc(expense.endDate).format('DD/MM/YYYY')
            : item.exitDate;
        });
        if (item.property.type === 'parking') {
          occupant.parking.price += item.property.price;
        } else {
          occupant.office.surface += item.property.surface;
          occupant.office.price += item.property.price;
        }
      }
      occupant.rental += item.rent || 0;
      occupant.expenses +=
        (item.expenses?.length &&
          item.expenses.reduce(
            (acc: number, { amount }: { amount: number }) => acc + amount,
            0
          )) ||
        0;
    });
    occupant.preTaxTotal =
      occupant.rental + occupant.expenses - occupant.discount;
    occupant.total = occupant.preTaxTotal;
    if (occupant.vatRatio) {
      occupant.vat = occupant.preTaxTotal * occupant.vatRatio;
      occupant.total = occupant.preTaxTotal + occupant.vat;
    }
  }

  occupant.hasPayments = occupant.rents
    ? occupant.rents.some(
        (rent: AnyRecord) =>
          (rent.payments &&
            rent.payments.some(
              (payment: AnyRecord) => payment.amount > 0
            )) ||
          rent.discounts.some(
            (discount: AnyRecord) => discount.origin === 'settlement'
          )
      )
    : false;
  delete occupant.rents;
  return occupant;
}

export function toProperty(
  inputProperty: CollectionTypes.Property,
  inputOccupant?: AnyRecord,
  inputOccupants?: AnyRecord[]
): AnyRecord {
  const currentDate = moment.utc();
  let property: AnyRecord = {
    _id: inputProperty._id,
    type: inputProperty.type,
    name: inputProperty.name,
    description: inputProperty.description,
    surface: inputProperty.surface,
    landSurface: inputProperty.landSurface,
    phone: inputProperty.phone,
    digicode: inputProperty.digicode,
    address: inputProperty.address,
    price: inputProperty.price,
    atakNumber: inputProperty.atakNumber,
    buildingId: inputProperty.buildingId || null,
    dehNumber: inputProperty.dehNumber,
    energyCertificate: inputProperty.energyCertificate,
    beginDate: '',
    endDate: '',
    lastBusyDay: '',
    occupantLabel: '',
    available: true,
    status: 'vacant'
  };
  if (inputOccupant) {
    property = {
      ...property,
      beginDate: moment.utc(inputOccupant.entryDate).format('DD/MM/YYYY'),
      endDate: moment.utc(inputOccupant.exitDate).format('DD/MM/YYYY'),
      lastBusyDay: moment.utc(
        inputOccupant.terminationDate || inputOccupant.endDate
      ).format('DD/MM/YYYY'),
      occupantLabel: inputOccupant.name
    };
    if (property.lastBusyDay) {
      property.available = moment.utc(
        property.lastBusyDay,
        'DD/MM/YYYY'
      ).isBefore(currentDate, 'day');
      if (!property.available) {
        property.status = 'occupied';
      }
    }
  }
  property.occupancyHistory = [];
  if (inputOccupants && inputOccupants.length) {
    property.occupancyHistory = inputOccupants.map((occupant: AnyRecord) => {
      return {
        id: occupant._id,
        name: occupant.name,
        beginDate: moment.utc(occupant.beginDate).format('DD/MM/YYYY'),
        endDate: moment.utc(
          occupant.terminationDate || occupant.endDate
        ).format('DD/MM/YYYY')
      };
    });
  }

  return property;
}
