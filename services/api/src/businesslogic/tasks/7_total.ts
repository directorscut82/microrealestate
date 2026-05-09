import type { Contract, Rent, Settlements } from './1_base.js';

export default function taskTotal(
  contract: Contract,
  rentDate: string,
  previousRent: Rent | null,
  settlements: Settlements | undefined,
  rent: Rent
): Rent {
  const preTaxAmount = (rent.preTaxAmounts || []).reduce(
    (total, preTaxAmount) => total + (Number(preTaxAmount.amount) || 0),
    0
  );
  const charges = (rent.charges || []).reduce(
    (total, charges) => total + (Number(charges.amount) || 0),
    0
  );
  const buildingChargesTotal = (rent.buildingCharges || []).reduce(
    (total, charge) => total + (Number(charge.amount) || 0),
    0
  );
  const debts = (rent.debts || []).reduce(
    (total, debt) => total + (Number(debt.amount) || 0),
    0
  );
  const discount = (rent.discounts || []).reduce(
    (total, discount) => total + (Number(discount.amount) || 0),
    0
  );
  const vat =
    Math.round(
      (rent.vats || []).reduce(
        (total, vat) => total + (Number(vat.amount) || 0),
        0
      ) * 100
    ) / 100;
  const payment = (rent.payments || []).reduce(
    (total, payment) => total + (Number(payment.amount) || 0),
    0
  );

  rent.total.preTaxAmount = Math.round(preTaxAmount * 100) / 100;
  rent.total.charges = Math.round(charges * 100) / 100;
  rent.total.debts = Math.round(debts * 100) / 100;
  rent.total.discount = Math.round(discount * 100) / 100;
  rent.total.vat = vat;
  const grandTotal = Math.round(
    (preTaxAmount + charges + buildingChargesTotal + debts - discount + vat + (rent.total.balance || 0)) *
      100
  ) / 100;
  rent.total.grandTotal = Number.isFinite(grandTotal) ? grandTotal : 0;
  rent.total.payment = Math.round(payment * 100) / 100;

  return rent;
}
