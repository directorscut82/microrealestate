import type { CollectionTypes } from '@microrealestate/types';
import moment from 'moment';

export interface Contract {
  begin: Date;
  end: Date;
  termination?: Date;
  frequency: string;
  terms?: number;
  properties: CollectionTypes.Tenant['properties'];
  vatRate?: number;
  discount?: number;
  rents: Rent[];
}

export interface Rent {
  term: number;
  month: number;
  year: number;
  preTaxAmounts: { description: string; amount: number }[];
  charges: { description: string; amount: number }[];
  discounts: { origin: string; description: string; amount: number }[];
  debts: { description: string; amount: number }[];
  vats: { origin: string; description: string; rate: number; amount: number }[];
  payments: { date: string; amount: number; type: string; reference: string; description?: string }[];
  description: string;
  balance?: number;
  total: {
    balance: number;
    preTaxAmount: number;
    charges: number;
    debts?: number;
    discount: number;
    vat: number;
    grandTotal: number;
    payment: number;
  };
}

export interface Settlements {
  payments?: { date: string; amount: number; type: string; reference: string; description?: string }[];
  debts?: { description: string; amount: number }[];
  discounts?: { origin?: string; description: string; amount: number }[];
  vats?: { origin: string; description: string; rate: number; amount: number }[];
  description?: string;
}

export type RentTask = (
  contract: Contract,
  rentDate: string,
  previousRent: Rent | null,
  settlements: Settlements | undefined,
  rent: Rent
) => Rent;

export default function taskBase(
  contract: Contract,
  rentDate: string,
  previousRent: Rent | null,
  settlements: Settlements | undefined,
  rent: Rent
): Rent {
  const currentMoment = moment(rentDate, 'DD/MM/YYYY HH:mm');
  rent.term = Number(currentMoment.format('YYYYMMDDHH'));
  if (contract.frequency === 'months') {
    rent.term = Number(
      moment(currentMoment).startOf('month').format('YYYYMMDDHH')
    );
  }
  if (contract.frequency === 'days') {
    rent.term = Number(
      moment(currentMoment).startOf('day').format('YYYYMMDDHH')
    );
  }
  if (contract.frequency === 'hours') {
    rent.term = Number(
      moment(currentMoment).startOf('hour').format('YYYYMMDDHH')
    );
  }
  rent.month = currentMoment.month() + 1;
  rent.year = currentMoment.year();

  contract.properties
    .filter((property) => {
      const entryMoment = moment(property.entryDate).startOf('day');
      const exitMoment = moment(property.exitDate).endOf('day');

      return currentMoment.isBetween(
        entryMoment,
        exitMoment,
        contract.frequency as moment.unitOfTime.StartOf,
        '[]'
      );
    })
    .forEach(function (property) {
      if (property.property) {
        const name = property.property.name || '';
        const preTaxAmount = property.rent || 0;
        const expenses = property.expenses || [];

        rent.preTaxAmounts.push({
          description: name,
          amount: preTaxAmount
        });

        if (expenses.length) {
          rent.charges.push(
            ...expenses
              .filter(({ beginDate, endDate }) => {
                const expenseBegin = moment(beginDate, 'DD/MM/YYYY').startOf(
                  'day'
                );
                const expenseEnd = moment(endDate, 'DD/MM/YYYY').endOf('day');

                return currentMoment.isBetween(
                  expenseBegin,
                  expenseEnd,
                  contract.frequency as moment.unitOfTime.StartOf,
                  '[]'
                );
              })
              .map(({ title, amount }) => ({
                description: title,
                amount
              }))
          );
        }
      }
    });
  if (settlements) {
    rent.description = settlements.description || '';
  }
  return rent;
}
