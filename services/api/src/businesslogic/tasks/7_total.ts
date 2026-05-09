import type { Contract, Rent, Settlements } from './1_base.js';

export default function taskTotal(
  contract: Contract,
  rentDate: string,
  previousRent: Rent | null,
  settlements: Settlements | undefined,
  rent: Rent
): Rent {
  const preTaxAmount = rent.preTaxAmounts.reduce(
    (total, preTaxAmount) => total + preTaxAmount.amount,
    0
  );
  const charges = rent.charges.reduce(
    (total, charges) => total + charges.amount,
    0
  );
  const buildingChargesTotal = (rent.buildingCharges || []).reduce(
    (total, charge) => total + charge.amount,
    0
  );
  const debts = rent.debts.reduce((total, debt) => total + debt.amount, 0);
  const discount = rent.discounts.reduce(
    (total, discount) => total + discount.amount,
    0
  );
  const vat =
    Math.round(rent.vats.reduce((total, vat) => total + vat.amount, 0) * 100) /
    100;
  const payment = rent.payments.reduce(
    (total, payment) => total + payment.amount,
    0
  );

  rent.total.preTaxAmount = Math.round(preTaxAmount * 100) / 100;
  rent.total.charges = Math.round(charges * 100) / 100;
  rent.total.debts = Math.round(debts * 100) / 100;
  rent.total.discount = Math.round(discount * 100) / 100;
  rent.total.vat = vat;
  rent.total.grandTotal =
    Math.round(
      (preTaxAmount + charges + buildingChargesTotal + debts - discount + vat + rent.total.balance) *
        100
    ) / 100;
  rent.total.payment = Math.round(payment * 100) / 100;

  return rent;
}
