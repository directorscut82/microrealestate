import type { Contract, Rent, Settlements } from './1_base.js';

export default function taskDiscounts(
  contract: Contract,
  rentDate: string,
  previousRent: Rent | null,
  settlements: Settlements | undefined,
  rent: Rent
): Rent {
  if (contract.discount) {
    const amount = Math.round((Number(contract.discount) || 0) * 100) / 100;
    if (Number.isFinite(amount) && amount > 0) {
      rent.discounts.push({
        origin: 'contract',
        description: 'Remise exceptionnelle',
        amount
      });
    }
  }

  if (settlements && settlements.discounts) {
    settlements.discounts.forEach((discount) => {
      const amount = Math.round((Number(discount.amount) || 0) * 100) / 100;
      if (Number.isFinite(amount) && amount > 0) {
        rent.discounts.push({
          origin: discount.origin || 'settlement',
          description: discount.description || '',
          amount
        });
      }
    });
  }
  return rent;
}
