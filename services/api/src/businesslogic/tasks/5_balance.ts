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
    const balance =
      (Number(previousRent.total.grandTotal) || 0) -
      (Number(previousRent.total.payment) || 0);
    rent.total.balance = Math.round(balance * 100) / 100;
  }
  return rent;
}
