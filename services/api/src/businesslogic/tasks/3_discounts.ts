import type { Contract, Rent, Settlements } from './1_base.js';

export default function taskDiscounts(
  contract: Contract,
  rentDate: string,
  previousRent: Rent | null,
  settlements: Settlements | undefined,
  rent: Rent
): Rent {
  if (contract.discount) {
    rent.discounts.push({
      origin: 'contract',
      description: 'Remise exceptionnelle',
      amount: contract.discount
    });
  }

  if (settlements && settlements.discounts) {
    settlements.discounts.forEach((discount) => {
      rent.discounts.push({
        origin: 'settlement',
        description: discount.description,
        amount: discount.amount
      });
    });
  }
  return rent;
}
