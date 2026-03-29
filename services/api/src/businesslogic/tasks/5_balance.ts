import type { Contract, Rent, Settlements } from './1_base.js';

export default function taskBalance(
  contract: Contract,
  rentDate: string,
  previousRent: Rent | null,
  settlements: Settlements | undefined,
  rent: Rent
): Rent {
  rent.balance = 0;
  if (previousRent) {
    rent.total.balance =
      previousRent.total.grandTotal - previousRent.total.payment;
  }
  return rent;
}
