import type { Contract, Rent, Settlements } from './1_base.js';

export default function taskPayments(
  contract: Contract,
  rentDate: string,
  previousRent: Rent | null,
  settlements: Settlements | undefined,
  rent: Rent
): Rent {
  if (settlements && settlements.payments) {
    settlements.payments.forEach((payment) => {
      const amount = Math.round((Number(payment.amount) || 0) * 100) / 100;
      if (Number.isFinite(amount) && amount > 0) {
        rent.payments.push({
          ...payment,
          amount
        });
      }
    });
  }
  return rent;
}
