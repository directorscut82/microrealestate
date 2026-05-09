import type { Contract, Rent, Settlements } from './1_base.js';

export default function taskTotal(
  contract: Contract,
  rentDate: string,
  previousRent: Rent | null,
  settlements: Settlements | undefined,
  rent: Rent
): Rent {
  const preTaxAmount = Math.round(
    (rent.preTaxAmounts || []).reduce(
      (total, preTaxAmount) => total + (Number(preTaxAmount.amount) || 0),
      0
    ) * 100
  ) / 100;

  const charges = Math.round(
    (rent.charges || []).reduce(
      (total, charges) => total + (Number(charges.amount) || 0),
      0
    ) * 100
  ) / 100;

  const buildingChargesTotal = Math.round(
    (rent.buildingCharges || []).reduce(
      (total, charge) => total + (Number(charge.amount) || 0),
      0
    ) * 100
  ) / 100;

  const debts = Math.round(
    (rent.debts || []).reduce(
      (total, debt) => total + (Number(debt.amount) || 0),
      0
    ) * 100
  ) / 100;

  const discount = Math.round(
    (rent.discounts || []).reduce(
      (total, discount) => total + (Number(discount.amount) || 0),
      0
    ) * 100
  ) / 100;

  const vat = Math.round(
    (rent.vats || []).reduce(
      (total, vat) => total + (Number(vat.amount) || 0),
      0
    ) * 100
  ) / 100;

  const payment = Math.round(
    (rent.payments || []).reduce(
      (total, payment) => total + (Number(payment.amount) || 0),
      0
    ) * 100
  ) / 100;

  rent.total.preTaxAmount = preTaxAmount;
  rent.total.charges = charges;
  rent.total.debts = debts;
  rent.total.discount = discount;
  rent.total.vat = vat;
  const grandTotal = Math.round(
    (preTaxAmount + charges + buildingChargesTotal + debts - discount + vat +
      (rent.total.balance || 0)) * 100
  ) / 100;
  rent.total.grandTotal = Number.isFinite(grandTotal) ? grandTotal : 0;
  rent.total.payment = payment;

  return rent;
}
