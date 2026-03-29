import type { Contract, Rent, Settlements } from './1_base.js';

export default function taskDebts(
  contract: Contract,
  rentDate: string,
  previousRent: Rent | null,
  settlements: Settlements | undefined,
  rent: Rent
): Rent {
  if (settlements && settlements.debts) {
    settlements.debts.forEach((debt) => {
      rent.debts.push({
        description: debt.description,
        amount: debt.amount
      });
    });
  }
  return rent;
}
