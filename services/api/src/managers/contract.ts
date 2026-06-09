import * as BL from '../businesslogic/index.js';
import type { Contract, Rent, Settlements } from '../businesslogic/index.js';
import _ from 'lodash';
import moment from 'moment';

export type { Contract, Rent, Settlements };

export function create(contract: Contract): Contract {
  const supportedFrequencies = ['hours', 'days', 'weeks', 'months', 'years'];

  if (
    !contract.frequency ||
    supportedFrequencies.indexOf(contract.frequency) === -1
  ) {
    throw Error(
      `unsupported frequency, should be one of these ${supportedFrequencies.join(
        ', '
      )}`
    );
  }

  if (!contract.properties || contract.properties.length === 0) {
    throw Error('properties not defined or empty');
  }

  const momentBegin = moment.utc(contract.begin);
  const momentEnd = moment.utc(contract.end);
  let momentTermination: moment.Moment | undefined;
  if (contract.termination) {
    momentTermination = moment.utc(contract.termination);
    // Tier D-B5: terminationDate must be STRICTLY AFTER beginDate. The
    // legacy inclusive bracket on the begin side ('[]') accepted
    // terminationDate === beginDate, which produced a zero-day contract
    // — rent ledger had no terms but a tenant.terminated flag — and
    // confused every downstream consumer (dashboard, accounting, PDF
    // receipt). The end side stays inclusive so a same-day end is OK.
    if (!momentTermination.isBetween(momentBegin, momentEnd, 'minutes', '(]')) {
      throw Error('termination date is out of the contract time frame');
    }
  }

  if (momentEnd.isSameOrBefore(momentBegin)) {
    throw Error(
      'contract duration is not correct, check begin/end contract date'
    );
  }

  const terms = Math.ceil(
    momentEnd.diff(momentBegin, contract.frequency as moment.unitOfTime.Diff, true)
  );
  contract = {
    ...contract,
    terms,
    rents: []
  };

  const current = moment.utc(momentBegin);
  let previousRent: Rent | null = null;
  while (
    current.isSameOrBefore(
      momentTermination || momentEnd,
      contract.frequency as moment.unitOfTime.StartOf
    )
  ) {
    const rent = BL.computeRent(
      contract,
      current.format('DD/MM/YYYY HH:mm'),
      previousRent
    );
    contract.rents.push(rent);
    previousRent = rent;
    current.add(1, contract.frequency as moment.unitOfTime.DurationConstructor);
  }
  // Defensive: rents are pushed in chronological order above, but downstream
  // consumers (rent ledger UI, payTerm previousRent lookup) assume sort by
  // term ascending. If any future change introduces out-of-order pushes,
  // this guarantees the invariant holds.
  contract.rents.sort((a, b) => Number(a.term) - Number(b.term));
  return contract;
}

export function update(inputContract: Contract, modification: Partial<Contract>): Contract {
  const originalContract = _.cloneDeep(inputContract);
  const modifiedContract: Contract = {
    ...originalContract,
    ...modification
  };

  const momentBegin = moment.utc(modifiedContract.begin);
  const momentEnd = moment.utc(modifiedContract.end);
  let momentTermination: moment.Moment | undefined;
  if (modifiedContract.termination) {
    momentTermination = moment.utc(modifiedContract.termination);
  }

  _checkLostPayments(
    momentBegin,
    momentTermination || momentEnd,
    inputContract
  );

  const updatedContract = create(modifiedContract);

  // Freeze past terms: re-pricing already-billed past rents is wrong.
  // After Contract.create rebuilt all rents from the new property/expense
  // state, restore every past rent (paid OR unpaid) from the original
  // document so their preTaxAmounts/charges/buildingCharges/discounts/
  // vats/total stay pinned to what was billed. Tier I-1 (June 2026):
  // past-unpaid rents are now also frozen — Greek tax norm treats closed
  // months as immutable; arrears get adjusted via explicit credit/debit
  // notes (existing debts[] settlement path), not by re-pricing on later
  // edits to building expenses or property rent. Current/future rents
  // keep the recomputed base and replay settlements via payTerm so
  // expense changes still take effect going forward.
  const currentTerm = _currentTermFor(modifiedContract);
  if (inputContract.rents) {
    // Pass 1: clone every past rent from inputContract by term-match.
    // This covers both past-paid (frozen) AND past-unpaid (now frozen
    // too) so an edit to a current building expense never reaches back
    // and re-prices a closed month, even one with no recorded payments.
    inputContract.rents.forEach((pastRent) => {
      if (typeof pastRent.term !== 'number' || pastRent.term >= currentTerm) {
        return;
      }
      const idx = updatedContract.rents.findIndex(
        (r) => r.term === pastRent.term
      );
      if (idx > -1) {
        updatedContract.rents[idx] = _.cloneDeep(pastRent);
      }
    });

    // Pass 2: for rents at or after the current term that carry
    // settlements (payments/discounts/debts/description), either freeze
    // a fully-paid current term or replay via payTerm so the new
    // pricing takes effect.
    inputContract.rents
      .filter(
        (rent) =>
          typeof rent.term === 'number' &&
          rent.term >= currentTerm &&
          _isPayment(rent)
      )
      .forEach((paidRent) => {
        if (_isFrozen(paidRent, currentTerm)) {
          const idx = updatedContract.rents.findIndex(
            (r) => r.term === paidRent.term
          );
          if (idx > -1) {
            updatedContract.rents[idx] = _.cloneDeep(paidRent);
          }
          return;
        }
        payTerm(updatedContract, paidRent.term, {
          payments: paidRent.payments,
          vats: paidRent.vats.filter((vat) => vat.origin === 'settlement'),
          discounts: paidRent.discounts.filter(
            (discount) => discount.origin === 'settlement'
          ),
          debts: paidRent.debts.filter(
            (debt) => debt.amount && debt.amount > 0
          ),
          description: paidRent.description
        });
      });
  }

  // Wave-20 F2: forward carry-in sweep after freeze restoration.
  //
  // create() computed every rent.total.balance using the NEW pricing
  // chain (because the loop runs chronologically with previousRent =
  // just-built new-price rent). The freeze restoration above pinned
  // frozen past terms back to their old (billed) values — but the
  // carry-in balance baked into each non-frozen rent still references
  // the new-price prior grandTotal/payment, not the actually-billed
  // restored ones.
  //
  // Concretely: tenant paid Jan-Apr fully at €400 (old). Landlord PATCHes
  // rent to €450. May was computed in create() with previousRent = NEW
  // April (grandTotal=450, payment=0) → May.balance=450, May.grandTotal
  // becomes 450+450=900, surfacing a phantom carry-in. After freeze
  // restoration April is back to OLD (grandTotal=400, payment=400), but
  // May still carries the stale balance unless we re-derive it here.
  //
  // Walk forward and recompute total.balance + grandTotal for every
  // non-frozen rent so its balance truly reflects the restored prior.
  const restoredRents = updatedContract.rents;
  for (let i = 1; i < restoredRents.length; i++) {
    const rent = restoredRents[i];
    if (!rent || !rent.total) continue;
    if (_isFrozen(rent, currentTerm)) continue;
    const prev = restoredRents[i - 1];
    if (!prev || !prev.total) continue;
    const prevDue = Number(prev.total.grandTotal) || 0;
    const prevPaid = Number(prev.total.payment) || 0;
    const newBalance = Math.round((prevDue - prevPaid) * 100) / 100;
    const oldBalance = Number(rent.total.balance) || 0;
    if (Math.abs(newBalance - oldBalance) < 0.005) continue;
    // Re-derive grandTotal: subtract old balance, add new balance.
    rent.total.balance = newBalance;
    const oldGrandTotal = Number(rent.total.grandTotal) || 0;
    rent.total.grandTotal =
      Math.round((oldGrandTotal - oldBalance + newBalance) * 100) / 100;
  }

  return updatedContract;
}

export function renew(contract: Contract): Contract {
  const momentEnd = moment.utc(contract.end);
  const momentNewEnd = moment.utc(momentEnd).add(
    contract.terms,
    contract.frequency as moment.unitOfTime.DurationConstructor
  );

  return {
    ...update(contract, { end: momentNewEnd.toDate() }),
    terms: contract.terms
  };
}

export function terminate(inputContract: Contract, termination: Date): Contract {
  return update(inputContract, { termination });
}

export function payTerm(
  contract: Contract,
  term: number | string,
  settlements: Settlements
): Contract {
  if (!contract.rents || !contract.rents.length) {
    throw Error('cannot pay term, the rents were not generated');
  }
  const current = moment.utc(term, 'YYYYMMDDHH');
  const momentBegin = moment.utc(contract.begin);
  const momentEnd = moment.utc(contract.termination || contract.end);

  if (
    !current.isBetween(
      momentBegin,
      momentEnd,
      contract.frequency as moment.unitOfTime.StartOf,
      '[]'
    )
  ) {
    throw Error('payment term is out of the contract time frame');
  }

  const previousTerm = moment.utc(current).subtract(
    1,
    contract.frequency as moment.unitOfTime.DurationConstructor
  );
  const previousRentIndex = contract.rents.findIndex(
    (rent) => rent.term === Number(previousTerm.format('YYYYMMDDHH'))
  );

  let previousRent: Rent | null =
    previousRentIndex > -1 ? contract.rents[previousRentIndex] : null;
  const targetTerm = Number(term);
  const currentTerm = _currentTermFor(contract);
  contract.rents.forEach((rent, index) => {
    if (index > previousRentIndex) {
      // Freeze: a past term (paid OR unpaid) that is NOT the term being
      // paid must not be re-priced when a later term is paid. Tier I-1
      // (June 2026): past-unpaid rents are now in scope of the freeze
      // via _isFrozen — closed months stay immutable through any later
      // settlement walk. The act of paying the current term may walk the
      // loop forward; that walk must skip already-frozen rents instead
      // of overwriting their charges.
      if (rent.term !== targetTerm && _isFrozen(rent, currentTerm)) {
        previousRent = contract.rents[index];
        current.add(1, contract.frequency as moment.unitOfTime.DurationConstructor);
        return;
      }
      if (index > previousRentIndex + 1) {
        const { debts, discounts, payments } = rent;
        settlements = {
          debts,
          discounts: discounts.filter((d) => d.origin === 'settlement'),
          payments
        };
      }
      contract.rents[index] = BL.computeRent(
        contract,
        current.format('DD/MM/YYYY HH:mm'),
        previousRent,
        settlements
      );
      previousRent = contract.rents[index];
      current.add(1, contract.frequency as moment.unitOfTime.DurationConstructor);
    }
  });

  return contract;
}

// "Frozen" = a rent that must NOT be re-priced when expenses, properties,
// or building charges change. Three regimes:
//   - Future term: never frozen — landlord may still adjust pricing.
//   - Past term: ALWAYS frozen — paid or unpaid. Greek tax norm: closed
//     months are immutable; arrears get adjusted via explicit credit/debit
//     notes (existing debts[] settlement path), not by re-pricing on later
//     edits to building expenses or property rent. Tier I-1 (June 2026)
//     replaced the prior _isPayment(rent) check, which thawed past-unpaid
//     terms and let a Feb expense edit retroactively raise an unpaid Feb
//     bill — distorting historical aging and pushing the tenant deeper
//     into arrears for an expense they were never billed.
//   - Current term (Wave-17 B2): frozen ONLY if fully paid. The previous
//     `<` check thawed the in-progress month even when the tenant had
//     already paid in full, so editing a building expense after payment
//     would re-price the bill and create a phantom debt (€505.6 paid →
//     €508.20 totalToPay → −€2.60 newBalance, status flips to
//     'partiallypaid'). Unpaid current-month rents stay thawed so a
//     mid-month expense edit takes effect before the tenant pays.
function _isFrozen(rent: Rent, currentTerm: number): boolean {
  if (!rent || typeof rent.term !== 'number') return false;
  if (rent.term > currentTerm) return false;
  if (rent.term < currentTerm) return true;
  return _isFullyPaid(rent);
}

// Sum payments[].amount and compare to totalToPay/totalAmount. Tolerate a
// 1-cent rounding gap so 505.6 + 0 + 0 == 505.60001 still counts as paid.
function _isFullyPaid(rent: Rent): boolean {
  const totalDue = Number(
    (rent as any)?.total?.grandTotal ??
      (rent as any)?.totalToPay ??
      (rent as any)?.totalAmount ??
      0
  );
  if (!Number.isFinite(totalDue) || totalDue <= 0) return false;
  const paid = (rent.payments || []).reduce(
    (s, p) => s + (Number(p.amount) || 0),
    0
  );
  return paid >= totalDue - 0.01;
}

// Compute the current term (YYYYMMDDHH) using the contract's frequency.
// 'months' is the dominant case in MRE; falls back to a generic startOf
// match for other frequencies.
function _currentTermFor(contract: Pick<Contract, 'frequency'>): number {
  const now = moment.utc();
  const freq = (contract?.frequency || 'months') as moment.unitOfTime.StartOf;
  return Number(now.startOf(freq).format('YYYYMMDDHH'));
}

const _isPayment = (rent: Rent): boolean => {
  return (
    rent.payments.some((payment) => payment.amount && payment.amount > 0) ||
    rent.discounts.some(
      (discount) =>
        discount.origin === 'settlement' &&
        discount.amount &&
        discount.amount > 0
    ) ||
    rent.debts.some((debt) => debt.amount && debt.amount > 0) ||
    !!rent.description
  );
};

const _checkLostPayments = (
  momentBegin: moment.Moment,
  momentEnd: moment.Moment,
  contract: Contract
): void => {
  if (!contract.rents || !contract.rents.length) {
    return;
  }

  const lostPayments = contract.rents
    .filter(
      (rent) =>
        !moment.utc(rent.term, 'YYYYMMDDHH').isBetween(
          momentBegin,
          momentEnd,
          contract.frequency as moment.unitOfTime.StartOf,
          '[]'
        ) && _isPayment(rent)
    )
    .map(
      (rent) =>
        String(rent.term) +
        ' ' +
        rent.payments.map((payment) => payment.amount).join(' + ')
    );

  if (lostPayments.length > 0) {
    throw Error(
      `Some payments will be lost because they are out of the contract time frame:\n${lostPayments.join(
        '\n'
      )}`
    );
  }
};
