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

    // Float math on `rate * 100` produces ugly remainders for tenants on
     // unusual VAT rates (e.g. 0.245 * 100 → 24.500000000000004). Round
     // the displayed percentage to 2 decimals so the description stays
     // human-readable. Computed amounts are unaffected — they continue
     // to use the precise `rate`.
    const _ratePct = Math.round(rate * 10000) / 100;

    rent.preTaxAmounts.forEach((preTaxAmount) => {
      const amount = Number(preTaxAmount.amount) || 0;
      rent.vats.push({
        origin: 'contract',
        description: `${preTaxAmount.description} T.V.A. (${_ratePct}%)`,
        amount: Math.round(amount * rate * 100) / 100,
        rate
      });
    });

    rent.charges.forEach((charges) => {
      const amount = Number(charges.amount) || 0;
      rent.vats.push({
        origin: 'contract',
        description: `${charges.description} T.V.A. (${_ratePct}%)`,
        amount: Math.round(amount * rate * 100) / 100,
        rate
      });
    });

    // KNOWN ISSUE (H6): VAT is NOT applied to rent.buildingCharges. The
    // building-charge feature (commit e80c095) and earlier upstream code
    // never added a VAT pass for them. Whether κοινόχρηστα should carry
    // VAT depends on Greek tax law context I don't have. Adding a naive
    // rate*amount line here changes grandTotal by ~vat% on every tenant
    // with building charges — risky without knowing the storage
    // convention. Documented and deferred to user.

    // Carried-forward debts (no `origin` field) are already gross — they
    // are previous-term grandTotal amounts that already include VAT.
    // Settlement-origin debts (extracharge entered on a payment) are
    // stored NET-of-VAT in rentmanager.ts via `_vatFactor`. They need
    // a compensating positive VAT line so grandTotal reflects the gross
    // value the landlord typed. Without this, a 124€ extra cost on a
    // 24% VAT rent silently lands as 100€ on grandTotal.
    rent.debts.forEach((debt) => {
      if (debt.origin !== 'settlement') return;
      const amount = Number(debt.amount) || 0;
      rent.vats.push({
        origin: 'settlement',
        description: `${debt.description} T.V.A. (${_ratePct}%)`,
        amount: Math.round(amount * rate * 100) / 100,
        rate
      });
    });

    rent.discounts.forEach((discount) => {
      const amount = Number(discount.amount) || 0;
      rent.vats.push({
        origin: discount.origin,
        description: `${discount.description} T.V.A. (${_ratePct}%)`,
        amount: Math.round(amount * rate * -1 * 100) / 100,
        rate
      });
    });
  }

  return rent;
}
