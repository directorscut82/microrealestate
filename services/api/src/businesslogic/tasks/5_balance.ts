import type { Contract, Rent, Settlements } from './1_base.js';

export default function taskBalance(
  contract: Contract,
  rentDate: string,
  previousRent: Rent | null,
  settlements: Settlements | undefined,
  rent: Rent
): Rent {
  // Defensive: a previousRent without a populated `total` object would
  // throw on Number(previousRent.total.grandTotal). frontdata.toRentData
  // already restores a default total when it is missing/non-object, but
  // a Rent constructed elsewhere (tests, ad-hoc managers) may still be
  // passed in with a partial shape. Fall through cleanly so the current
  // term computes a 0 carry-in instead of crashing the whole pipeline.
  if (!previousRent || !previousRent.total) return rent;
  const balance =
    (Number(previousRent.total.grandTotal) || 0) -
    (Number(previousRent.total.payment) || 0);
  rent.total.balance = Math.round(balance * 100) / 100;
  return rent;
}
