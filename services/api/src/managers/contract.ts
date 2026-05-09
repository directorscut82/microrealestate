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

  const current = moment(momentBegin);
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

  if (inputContract.rents) {
    inputContract.rents
      .filter((rent) => _isPayment(rent))
      .forEach((paidRent) => {
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
  contract.rents.forEach((rent, index) => {
    if (index > previousRentIndex) {
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
