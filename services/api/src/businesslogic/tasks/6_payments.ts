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
      rent.payments.push(payment);
    });
  }
  return rent;
}
