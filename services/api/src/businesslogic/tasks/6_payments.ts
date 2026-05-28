import type { Contract, Rent, Settlements } from './1_base.js';

export default function taskPayments(
  contract: Contract,
  rentDate: string,
  previousRent: Rent | null,
  settlements: Settlements | undefined,
  rent: Rent
): Rent {
  if (settlements && settlements.payments) {
    settlements.payments.forEach((payment) => {
      const amount = Math.round((Number(payment.amount) || 0) * 100) / 100;
      if (Number.isFinite(amount) && amount > 0) {
        // Wave-25: normalize allocation amounts to the same 2-decimal
        // rounding used for the payment amount itself. The validator in
        // rentmanager already enforced shape; we just round on the way in.
        // The Settlements payment type doesn't declare `allocation`
        // (rents are Mixed-schema), so we read it via an `unknown` cast.
        const rawAlloc = (payment as unknown as { allocation?: unknown }).allocation;
        const allocation = Array.isArray(rawAlloc)
          ? (rawAlloc as { category: string; amount: number }[]).map((a) => ({
              category: a.category,
              amount: Math.round((Number(a.amount) || 0) * 100) / 100
            }))
          : undefined;
        // Drop the original `allocation` from the spread before re-emitting:
        // an incoming empty array would otherwise survive the spread and
        // make legacy reads that key off "allocation present" misfire.
        const { allocation: _stripped, ...rest } = payment as unknown as {
          allocation?: unknown;
          [k: string]: unknown;
        };
        void _stripped;
        rent.payments.push({
          ...(rest as { date: string; amount: number; type: string; reference: string; description?: string }),
          amount,
          ...(allocation && allocation.length ? { allocation } : {})
        } as unknown as { date: string; amount: number; type: string; reference: string; description?: string });
      }
    });
  }
  return rent;
}
