import type { Contract, Rent, Settlements } from './1_base.js';

export default function taskVATs(
  contract: Contract,
  rentDate: string,
  previousRent: Rent | null,
  settlements: Settlements | undefined,
  rent: Rent
): Rent {
  if (contract.vatRate) {
    let rate = Number(contract.vatRate) || 0;

    // Guard: must be finite
    if (!Number.isFinite(rate)) rate = 0;
    // Guard: rate should be 0-1 (ratio). If > 1, likely a percentage (e.g., 20 instead of 0.20)
    if (rate > 1) {
      rate = rate / 100;
    }
    if (rate < 0) rate = 0;
    if (rate > 1) rate = 1; // Cap at 100% after conversion

    rent.preTaxAmounts.forEach((preTaxAmount) => {
      const amount = Number(preTaxAmount.amount) || 0;
      rent.vats.push({
        origin: 'contract',
        description: `${preTaxAmount.description} T.V.A. (${rate * 100}%)`,
        amount: Math.round(amount * rate * 100) / 100,
        rate
      });
    });

    rent.charges.forEach((charges) => {
      const amount = Number(charges.amount) || 0;
      rent.vats.push({
        origin: 'contract',
        description: `${charges.description} T.V.A. (${rate * 100}%)`,
        amount: Math.round(amount * rate * 100) / 100,
        rate
      });
    });

    // NOTE: Do NOT apply VAT to debts — they are carried-forward grandTotal
    // amounts from previous terms that already include VAT.

    rent.discounts.forEach((discount) => {
      const amount = Number(discount.amount) || 0;
      rent.vats.push({
        origin: discount.origin,
        description: `${discount.description} T.V.A. (${rate * 100}%)`,
        amount: Math.round(amount * rate * -1 * 100) / 100,
        rate
      });
    });
  }

  return rent;
}
