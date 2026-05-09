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
      const amount = Math.round((Number(debt.amount) || 0) * 100) / 100;
      if (Number.isFinite(amount) && amount > 0) {
        rent.debts.push({
          description: debt.description || '',
          amount
        });
      }
    });
  }
  return rent;
}
