/* eslint-env node */
import * as Contract from '../../managers/contract.js';
import moment from 'moment';

// Balance-cascade tests must run in the NON-FROZEN window. Past terms are
// ALWAYS frozen (Tier I-1, June 2026: closed months are immutable — paying
// a later term does not re-price an earlier one). The old tests hard-coded
// 2020 dates, which are now years in the past and therefore frozen, so the
// cascade they assert no longer fires. Anchor the contract at the CURRENT
// month so Jan→Feb→Mar map to current/future (unfrozen) terms — keeping the
// suite both deterministic and a true test of the live cascade path.
const _m0 = moment.utc().startOf('month');
const anchorBegin = _m0.clone().toDate().getTime();
const anchorMonth = (i) => _m0.clone().add(i, 'months');
const anchorEnd = (i) => anchorMonth(i).clone().endOf('month').toDate().getTime();
const anchorTerm = (i) => anchorMonth(i).format('YYYYMMDDHH');

describe('contract payment edge cases', () => {
  describe('payTerm validation', () => {
    it('should throw if rents array is empty', () => {
      const contract = {
        begin: Date.parse('2020-01-01T00:00:00Z'),
        end: Date.parse('2020-12-31T23:59:59Z'),
        frequency: 'months',
        properties: [{}, {}],
        rents: []
      };
      expect(() => Contract.payTerm(contract, '2020010100', {
        payments: [{ amount: 100 }]
      })).toThrow('cannot pay term, the rents were not generated');
    });

    it('should throw if term is outside contract range', () => {
      const contract = Contract.create({
        begin: Date.parse('2020-01-01T00:00:00Z'),
        end: Date.parse('2020-12-31T23:59:59Z'),
        frequency: 'months',
        properties: [{}, {}]
      });
      expect(() => Contract.payTerm(contract, '2019120100', {
        payments: [{ amount: 100 }]
      })).toThrow('out of the contract time frame');
      expect(() => Contract.payTerm(contract, '2021010100', {
        payments: [{ amount: 100 }]
      })).toThrow('out of the contract time frame');
    });

    it('should handle zero payment amount gracefully', () => {
      const contract = Contract.create({
        begin: Date.parse('2020-01-01T00:00:00Z'),
        end: Date.parse('2020-03-31T23:59:59Z'),
        frequency: 'months',
        properties: [{
          entryDate: Date.parse('2020-01-01T00:00:00Z'),
          exitDate: Date.parse('2020-03-31T23:59:59Z'),
          property: { name: 'test', price: 500 },
          rent: 500,
          expenses: []
        }]
      });
      Contract.payTerm(contract, '2020010100', {
        payments: [{ amount: 0 }]
      });
      const rent = contract.rents.find(r => r.term === 2020010100);
      expect(rent.payments.length).toBe(0);
      expect(rent.total.payment).toBe(0);
    });

    it('should correctly cascade balance after payment', () => {
      // Anchored at the current month so term0..term5 are current/future
      // (unfrozen) — see the anchor* helpers at the top of this file.
      const contract = Contract.create({
        begin: anchorBegin,
        end: anchorEnd(5),
        frequency: 'months',
        properties: [{
          entryDate: anchorBegin,
          exitDate: anchorEnd(5),
          property: { name: 'office', price: 1000 },
          rent: 1000,
          expenses: []
        }]
      });

      // Pay the first (current) month fully
      Contract.payTerm(contract, anchorTerm(0), {
        payments: [{ amount: 1000 }]
      });

      // Month 1 balance should be 0 (month 0 fully paid)
      const feb = contract.rents.find(r => r.term === Number(anchorTerm(1)));
      expect(feb.total.balance).toBe(0);
      expect(feb.total.grandTotal).toBe(1000);

      // Don't pay month 1 - month 2 should show unpaid balance
      const mar = contract.rents.find(r => r.term === Number(anchorTerm(2)));
      expect(mar.total.balance).toBe(1000);
      expect(mar.total.grandTotal).toBe(2000);
    });

    it('should handle partial payment correctly', () => {
      const contract = Contract.create({
        begin: anchorBegin,
        end: anchorEnd(2),
        frequency: 'months',
        properties: [{
          entryDate: anchorBegin,
          exitDate: anchorEnd(2),
          property: { name: 'office', price: 1000 },
          rent: 1000,
          expenses: []
        }]
      });

      // Pay 600 out of 1000 on the current month
      Contract.payTerm(contract, anchorTerm(0), {
        payments: [{ amount: 600 }]
      });

      const jan = contract.rents.find(r => r.term === Number(anchorTerm(0)));
      expect(jan.total.payment).toBe(600);
      expect(jan.total.grandTotal).toBe(1000);

      // Next month should carry the 400 balance
      const feb = contract.rents.find(r => r.term === Number(anchorTerm(1)));
      expect(feb.total.balance).toBe(400);
      expect(feb.total.grandTotal).toBe(1400);
    });

    it('should handle multiple payments on same term', () => {
      const contract = Contract.create({
        begin: Date.parse('2020-01-01T00:00:00Z'),
        end: Date.parse('2020-03-31T23:59:59Z'),
        frequency: 'months',
        properties: [{
          entryDate: Date.parse('2020-01-01T00:00:00Z'),
          exitDate: Date.parse('2020-03-31T23:59:59Z'),
          property: { name: 'office', price: 1000 },
          rent: 1000,
          expenses: []
        }]
      });

      Contract.payTerm(contract, '2020010100', {
        payments: [
          { amount: 400, type: 'cash' },
          { amount: 600, type: 'transfer' }
        ]
      });

      const jan = contract.rents.find(r => r.term === 2020010100);
      expect(jan.payments.length).toBe(2);
      expect(jan.total.payment).toBe(1000);
    });

    it('should handle debts (extra charges) in settlements', () => {
      const contract = Contract.create({
        begin: Date.parse('2020-01-01T00:00:00Z'),
        end: Date.parse('2020-03-31T23:59:59Z'),
        frequency: 'months',
        properties: [{
          entryDate: Date.parse('2020-01-01T00:00:00Z'),
          exitDate: Date.parse('2020-03-31T23:59:59Z'),
          property: { name: 'office', price: 1000 },
          rent: 1000,
          expenses: []
        }]
      });

      Contract.payTerm(contract, '2020010100', {
        payments: [{ amount: 1200 }],
        debts: [{ description: 'late fee', amount: 50 }]
      });

      const jan = contract.rents.find(r => r.term === 2020010100);
      expect(jan.debts.length).toBe(1);
      expect(jan.debts[0].amount).toBe(50);
      expect(jan.total.grandTotal).toBe(1050);
      expect(jan.total.payment).toBe(1200);
    });

    it('should handle discounts in settlements', () => {
      const contract = Contract.create({
        begin: Date.parse('2020-01-01T00:00:00Z'),
        end: Date.parse('2020-03-31T23:59:59Z'),
        frequency: 'months',
        properties: [{
          entryDate: Date.parse('2020-01-01T00:00:00Z'),
          exitDate: Date.parse('2020-03-31T23:59:59Z'),
          property: { name: 'office', price: 1000 },
          rent: 1000,
          expenses: []
        }]
      });

      Contract.payTerm(contract, '2020010100', {
        payments: [{ amount: 900 }],
        discounts: [{ origin: 'settlement', description: 'early pay', amount: 100 }]
      });

      const jan = contract.rents.find(r => r.term === 2020010100);
      expect(jan.discounts.length).toBe(1);
      expect(jan.total.discount).toBe(100);
      expect(jan.total.grandTotal).toBe(900);
      expect(jan.total.payment).toBe(900);
    });
  });

  describe('contract update with lost payments guard', () => {
    it('should throw if reducing contract range would lose paid rent', () => {
      const contract = Contract.create({
        begin: Date.parse('2020-01-01T00:00:00Z'),
        end: Date.parse('2020-12-31T23:59:59Z'),
        frequency: 'months',
        properties: [{
          entryDate: Date.parse('2020-01-01T00:00:00Z'),
          exitDate: Date.parse('2020-12-31T23:59:59Z'),
          property: { name: 'office', price: 1000 },
          rent: 1000,
          expenses: []
        }]
      });

      Contract.payTerm(contract, '2020120100', {
        payments: [{ amount: 1000 }]
      });

      // Try to shorten the contract to end in November — should lose December payment
      expect(() => Contract.update(contract, {
        end: Date.parse('2020-11-30T23:59:59Z')
      })).toThrow('payments will be lost');
    });

    it('should preserve payments when extending contract', () => {
      const contract = Contract.create({
        begin: Date.parse('2020-01-01T00:00:00Z'),
        end: Date.parse('2020-06-30T23:59:59Z'),
        frequency: 'months',
        properties: [{
          entryDate: Date.parse('2020-01-01T00:00:00Z'),
          exitDate: Date.parse('2020-06-30T23:59:59Z'),
          property: { name: 'office', price: 500 },
          rent: 500,
          expenses: []
        }]
      });

      Contract.payTerm(contract, '2020030100', {
        payments: [{ amount: 500 }]
      });

      const extended = Contract.update(contract, {
        end: Date.parse('2020-12-31T23:59:59Z')
      });

      const march = extended.rents.find(r => r.term === 2020030100);
      expect(march.payments[0].amount).toBe(500);
      expect(extended.rents.length).toBe(12);
    });
  });

  describe('VAT computation', () => {
    it('should auto-convert percentage VAT rate to ratio', () => {
      const contract = Contract.create({
        begin: Date.parse('2020-01-01T00:00:00Z'),
        end: Date.parse('2020-01-31T23:59:59Z'),
        frequency: 'months',
        vatRate: 20,
        properties: [{
          entryDate: Date.parse('2020-01-01T00:00:00Z'),
          exitDate: Date.parse('2020-01-31T23:59:59Z'),
          property: { name: 'office', price: 1000 },
          rent: 1000,
          expenses: []
        }]
      });

      const rent = contract.rents[0];
      expect(rent.vats[0].rate).toBe(0.2);
      expect(rent.vats[0].amount).toBe(200);
      expect(rent.total.vat).toBe(200);
      expect(rent.total.grandTotal).toBe(1200);
    });

    it('should handle zero VAT rate', () => {
      const contract = Contract.create({
        begin: Date.parse('2020-01-01T00:00:00Z'),
        end: Date.parse('2020-01-31T23:59:59Z'),
        frequency: 'months',
        vatRate: 0,
        properties: [{
          entryDate: Date.parse('2020-01-01T00:00:00Z'),
          exitDate: Date.parse('2020-01-31T23:59:59Z'),
          property: { name: 'office', price: 1000 },
          rent: 1000,
          expenses: []
        }]
      });

      const rent = contract.rents[0];
      expect(rent.total.vat).toBe(0);
      expect(rent.total.grandTotal).toBe(1000);
    });
  });

  describe('rounding precision', () => {
    it('should not have floating point drift over many terms', () => {
      const contract = Contract.create({
        begin: Date.parse('2020-01-01T00:00:00Z'),
        end: Date.parse('2020-12-31T23:59:59Z'),
        frequency: 'months',
        vatRate: 0.24,
        properties: [{
          entryDate: Date.parse('2020-01-01T00:00:00Z'),
          exitDate: Date.parse('2020-12-31T23:59:59Z'),
          property: { name: 'office', price: 333.33 },
          rent: 333.33,
          expenses: [{ title: 'cleaning', amount: 16.67, beginDate: '01/01/2020', endDate: '31/12/2020' }]
        }]
      });

      // Every rent amount should be properly rounded (2 decimal places)
      contract.rents.forEach(rent => {
        expect(rent.total.grandTotal).toBe(Math.round(rent.total.grandTotal * 100) / 100);
        expect(rent.total.preTaxAmount).toBe(Math.round(rent.total.preTaxAmount * 100) / 100);
        expect(rent.total.vat).toBe(Math.round(rent.total.vat * 100) / 100);
      });
    });
  });
});
