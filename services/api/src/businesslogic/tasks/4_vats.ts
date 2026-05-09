import type { Contract, Rent, Settlements } from './1_base.js';

export default function taskVATs(
  contract: Contract,
  rentDate: string,
  previousRent: Rent | null,
  settlements: Settlements | undefined,
  rent: Rent
): Rent {
  if (contract.vatRate) {
    const rate = contract.vatRate || 0;

    rent.preTaxAmounts.forEach((preTaxAmount) => {
      rent.vats.push({
        origin: 'contract',
        description: `${preTaxAmount.description} T.V.A. (${rate * 100}%)`,
        amount: Math.round(preTaxAmount.amount * rate * 100) / 100,
        rate
      });
    });

    rent.charges.forEach((charges) => {
      rent.vats.push({
        origin: 'contract',
        description: `${charges.description} T.V.A. (${rate * 100}%)`,
        amount: Math.round(charges.amount * rate * 100) / 100,
        rate
      });
    });

    // NOTE: Do NOT apply VAT to debts — they are carried-forward grandTotal
    // amounts from previous terms that already include VAT.

    rent.discounts.forEach((discount) => {
      rent.vats.push({
        origin: discount.origin,
        description: `${discount.description} T.V.A. (${rate * 100}%)`,
        amount: Math.round(discount.amount * rate * -1 * 100) / 100,
        rate
      });
    });
  }

  return rent;
}
