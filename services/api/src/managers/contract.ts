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
    if (!momentTermination.isBetween(momentBegin, momentEnd, 'minutes', '[]')) {
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

  // Freeze paid past terms: re-pricing already-paid bills (V9/V10) is wrong.
  // After Contract.create rebuilt all rents from the new property/expense
  // state, restore frozen past paid rents from the original document so
  // their preTaxAmounts/charges/buildingCharges/discounts/vats/total stay
  // pinned to what was billed. Non-frozen rents (current/future, or
  // unpaid past) keep the recomputed base and replay settlements via
  // payTerm so expense changes still take effect going forward.
  const currentTerm = _currentTermFor(modifiedContract);
  if (inputContract.rents) {
    inputContract.rents
      .filter((rent) => _isPayment(rent))
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
      // Freeze: a paid past term that is NOT the term being paid must not
      // be re-priced when a later term is paid. The act of paying the
      // current term may walk the loop forward; that walk must skip
      // already-frozen rents instead of overwriting their charges.
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
//   - Past term with any settlement: frozen — historical bills are
//     immutable once any settlement has been recorded against them.
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
  if (rent.term < currentTerm) return _isPayment(rent);
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
