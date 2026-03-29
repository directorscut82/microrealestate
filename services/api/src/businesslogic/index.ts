/* eslint-disable sort-imports */
import type { Contract, Rent, RentTask, Settlements } from './tasks/1_base.js';
import taskBase from './tasks/1_base.js';
import taskDebts from './tasks/2_debts.js';
import taskDiscounts from './tasks/3_discounts.js';
import taskVATs from './tasks/4_vats.js';
import taskBalance from './tasks/5_balance.js';
import taskPayments from './tasks/6_payments.js';
import taskTotal from './tasks/7_total.js';

export type { Contract, Rent, Settlements };

export function computeRent(
  contract: Contract,
  rentDate: string,
  previousRent: Rent | null,
  settlements?: Settlements
): Rent {
  let rent: Rent = {
    term: 0,
    month: 0,
    year: 0,
    preTaxAmounts: [],
    charges: [],
    discounts: [],
    debts: [],
    vats: [],
    payments: [],
    description: '',
    total: {
      balance: 0,
      preTaxAmount: 0,
      charges: 0,
      discount: 0,
      vat: 0,
      grandTotal: 0,
      payment: 0
    }
  };

  const tasks: RentTask[] = [
    taskBase,
    taskDebts,
    taskDiscounts,
    taskVATs,
    taskBalance,
    taskPayments,
    taskTotal
  ];

  tasks.forEach((task) => {
    rent = task(contract, rentDate, previousRent, settlements, rent);
  });

  return rent;
}
