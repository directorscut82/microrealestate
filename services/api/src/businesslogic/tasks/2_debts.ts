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
          amount,
          // Tag settlement-origin debts so 4_vats.ts can apply VAT only
          // to user-entered extra charges (which rentmanager.ts stores
          // net-of-VAT). Carried-forward debts from prior terms are
          // already gross and have no `origin` field.
          ...(debt.origin ? { origin: debt.origin } : {})
        });
      }
    });
  }
  return rent;
}
