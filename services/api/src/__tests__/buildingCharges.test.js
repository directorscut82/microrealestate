import * as BL from '../businesslogic/index.js';

describe('Building Charges Integration', () => {
  const makeProperty = (propertyId, rent = 500) => ({
    propertyId,
    rent,
    expenses: [],
    entryDate: new Date('2024-01-01'),
    exitDate: new Date('2024-12-31')
  });

  const makeBuilding = (atakPrefix, units = [], expenses = []) => ({
    _id: 'building1',
    name: `Building ${atakPrefix}`,
    atakPrefix,
    units,
    expenses,
    address: {},
    blockStreets: [],
    hasElevator: false,
    hasCentralHeating: false,
    contractors: [],
    repairs: []
  });

  const makeUnit = (propertyId, thousandths = {}) => ({
    _id: 'unit1',
    propertyId,
    atakNumber: '01234567890',
    isManaged: true,
    surface: 80,
    generalThousandths: thousandths.general || 0,
    heatingThousandths: thousandths.heating || 0,
    elevatorThousandths: thousandths.elevator || 0,
    owners: [],
    monthlyCharges: []
  });

  const makeExpense = (name, amount, method, overrides = {}) => ({
    _id: 'exp1',
    name,
    type: 'heating',
    amount,
    allocationMethod: method,
    isRecurring: true,
    customAllocations: [],
    ...overrides
  });

  const makeContract = (properties, buildings = []) => ({
    begin: new Date('2024-01-01'),
    end: new Date('2024-12-31'),
    frequency: 'months',
    properties,
    buildings,
    rents: []
  });

  describe('Allocation Methods', () => {
    it('should compute general_thousandths correctly', () => {
      const prop1 = makeProperty('prop1', 500);
      const unit1 = makeUnit('prop1', { general: 300 });
      const unit2 = { ...makeUnit('prop2', { general: 700 }), _id: 'unit2' };

      const expense = makeExpense('Cleaning', 1000, 'general_thousandths');
      const building = makeBuilding('011172', [unit1, unit2], [expense]);

      const contract = makeContract([prop1], [building]);
      const rent = BL.computeRent(contract, '01/01/2024 00:00', null);

      expect(rent.buildingCharges).toHaveLength(1);
      expect(rent.buildingCharges[0].amount).toBe(300); // 1000 * 300/1000
      expect(rent.buildingCharges[0].description).toBe('Cleaning');
    });

    it('should compute heating_thousandths correctly', () => {
      const prop1 = makeProperty('prop1', 500);
      const unit1 = makeUnit('prop1', { heating: 400 });
      const unit2 = { ...makeUnit('prop2', { heating: 600 }), _id: 'unit2' };

      const expense = makeExpense('Heating', 600, 'heating_thousandths');
      const building = makeBuilding('011172', [unit1, unit2], [expense]);

      const contract = makeContract([prop1], [building]);
      const rent = BL.computeRent(contract, '01/01/2024 00:00', null);

      expect(rent.buildingCharges).toHaveLength(1);
      expect(rent.buildingCharges[0].amount).toBe(240); // 600 * 400/1000
    });

    it('should compute elevator_thousandths correctly (ground floor excluded)', () => {
      const prop1 = makeProperty('prop1', 500);
      const unit1 = makeUnit('prop1', { elevator: 0 }); // Ground floor
      const unit2 = { ...makeUnit('prop2', { elevator: 500 }), _id: 'unit2' };
      const unit3 = { ...makeUnit('prop3', { elevator: 500 }), _id: 'unit3' };

      const expense = makeExpense('Elevator', 150, 'elevator_thousandths');
      const building = makeBuilding('011172', [unit1, unit2, unit3], [expense]);

      const contract = makeContract([prop1], [building]);
      const rent = BL.computeRent(contract, '01/01/2024 00:00', null);

      expect(rent.buildingCharges).toHaveLength(0); // Ground floor excluded (0 thousandths filtered out)
    });

    it('should compute equal allocation correctly', () => {
      const prop1 = makeProperty('prop1', 500);
      const unit1 = makeUnit('prop1');
      const unit2 = { ...makeUnit('prop2'), _id: 'unit2' };
      const unit3 = { ...makeUnit('prop3'), _id: 'unit3' };

      const expense = makeExpense('Pest Control', 120, 'equal');
      const building = makeBuilding('011172', [unit1, unit2, unit3], [expense]);

      const contract = makeContract([prop1], [building]);
      const rent = BL.computeRent(contract, '01/01/2024 00:00', null);

      expect(rent.buildingCharges).toHaveLength(1);
      expect(rent.buildingCharges[0].amount).toBe(40); // 120 / 3
    });

    it('should compute by_surface allocation correctly', () => {
      const prop1 = makeProperty('prop1', 500);
      const unit1 = { ...makeUnit('prop1'), surface: 80 };
      const unit2 = { ...makeUnit('prop2'), _id: 'unit2', surface: 120 };

      const expense = makeExpense('Insurance', 200, 'by_surface');
      const building = makeBuilding('011172', [unit1, unit2], [expense]);

      const contract = makeContract([prop1], [building]);
      const rent = BL.computeRent(contract, '01/01/2024 00:00', null);

      expect(rent.buildingCharges).toHaveLength(1);
      expect(rent.buildingCharges[0].amount).toBe(80); // 200 * 80/200
    });

    it('should compute fixed allocation correctly', () => {
      const prop1 = makeProperty('prop1', 500);
      const unit1 = makeUnit('prop1');

      const expense = makeExpense('Special Assessment', 0, 'fixed', {
        customAllocations: [{ propertyId: 'prop1', value: 250 }]
      });
      const building = makeBuilding('011172', [unit1], [expense]);

      const contract = makeContract([prop1], [building]);
      const rent = BL.computeRent(contract, '01/01/2024 00:00', null);

      expect(rent.buildingCharges).toHaveLength(1);
      expect(rent.buildingCharges[0].amount).toBe(250);
    });

    it('should compute custom_ratio allocation correctly', () => {
      const prop1 = makeProperty('prop1', 500);
      const unit1 = makeUnit('prop1');
      const unit2 = { ...makeUnit('prop2'), _id: 'unit2' };

      const expense = makeExpense('Custom Expense', 600, 'custom_ratio', {
        customAllocations: [
          { propertyId: 'prop1', value: 2 },
          { propertyId: 'prop2', value: 3 }
        ]
      });
      const building = makeBuilding('011172', [unit1, unit2], [expense]);

      const contract = makeContract([prop1], [building]);
      const rent = BL.computeRent(contract, '01/01/2024 00:00', null);

      expect(rent.buildingCharges).toHaveLength(1);
      expect(rent.buildingCharges[0].amount).toBe(240); // 600 * 2/5
    });

    it('should compute custom_percentage allocation correctly', () => {
      const prop1 = makeProperty('prop1', 500);
      const unit1 = makeUnit('prop1');

      const expense = makeExpense('Custom %', 1000, 'custom_percentage', {
        customAllocations: [{ propertyId: 'prop1', value: 35 }]
      });
      const building = makeBuilding('011172', [unit1], [expense]);

      const contract = makeContract([prop1], [building]);
      const rent = BL.computeRent(contract, '01/01/2024 00:00', null);

      expect(rent.buildingCharges).toHaveLength(1);
      expect(rent.buildingCharges[0].amount).toBe(350); // 1000 * 35/100
    });
  });

  describe('Term Filtering', () => {
    it('should include recurring expense active for term', () => {
      const prop1 = makeProperty('prop1', 500);
      const unit1 = makeUnit('prop1', { general: 1000 });

      const expense = makeExpense('Heating', 600, 'general_thousandths', {
        isRecurring: true,
        startTerm: 2024010100,
        endTerm: 2024120100
      });
      const building = makeBuilding('011172', [unit1], [expense]);

      const contract = makeContract([prop1], [building]);
      const rent = BL.computeRent(contract, '01/03/2024 00:00', null);

      expect(rent.buildingCharges).toHaveLength(1);
      expect(rent.buildingCharges[0].amount).toBe(600);
    });

    it('should exclude expense before startTerm', () => {
      const prop1 = makeProperty('prop1', 500);
      const unit1 = makeUnit('prop1', { general: 1000 });

      const expense = makeExpense('Future Expense', 600, 'general_thousandths', {
        startTerm: 2024060100
      });
      const building = makeBuilding('011172', [unit1], [expense]);

      const contract = makeContract([prop1], [building]);
      const rent = BL.computeRent(contract, '01/03/2024 00:00', null);

      expect(rent.buildingCharges).toHaveLength(0);
    });

    it('should exclude expense after endTerm', () => {
      const prop1 = makeProperty('prop1', 500);
      const unit1 = makeUnit('prop1', { general: 1000 });

      const expense = makeExpense('Past Expense', 600, 'general_thousandths', {
        endTerm: 2024020100
      });
      const building = makeBuilding('011172', [unit1], [expense]);

      const contract = makeContract([prop1], [building]);
      const rent = BL.computeRent(contract, '01/03/2024 00:00', null);

      expect(rent.buildingCharges).toHaveLength(0);
    });
  });

  describe('Monthly Charges', () => {
    it('should include monthly charge for matching term', () => {
      const prop1 = makeProperty('prop1', 500);
      const unit1 = {
        ...makeUnit('prop1'),
        monthlyCharges: [
          { _id: 'charge1', term: 2024030100, amount: 80, description: 'Κοινόχρηστα Μαρτίου' }
        ]
      };

      const building = makeBuilding('011172', [unit1], []);

      const contract = makeContract([prop1], [building]);
      const rent = BL.computeRent(contract, '01/03/2024 00:00', null);

      expect(rent.buildingCharges).toHaveLength(1);
      expect(rent.buildingCharges[0].amount).toBe(80);
      expect(rent.buildingCharges[0].description).toBe('Κοινόχρηστα Μαρτίου');
    });

    it('should not include monthly charge for different term', () => {
      const prop1 = makeProperty('prop1', 500);
      const unit1 = {
        ...makeUnit('prop1'),
        monthlyCharges: [
          { _id: 'charge1', term: 2024040100, amount: 80, description: 'Απριλίου' }
        ]
      };

      const building = makeBuilding('011172', [unit1], []);

      const contract = makeContract([prop1], [building]);
      const rent = BL.computeRent(contract, '01/03/2024 00:00', null);

      expect(rent.buildingCharges).toHaveLength(0);
    });
  });

  describe('Total Integration', () => {
    it('should add building charges to total charges', () => {
      const prop1 = makeProperty('prop1', 500);
      prop1.property = { name: 'Property 1' };
      prop1.expenses = [{ title: 'Property Expense', amount: 50, beginDate: '01/01/2024', endDate: '31/12/2024' }];

      const unit1 = makeUnit('prop1', { general: 1000 });
      const expense = makeExpense('Building Expense', 100, 'general_thousandths');
      const building = makeBuilding('011172', [unit1], [expense]);

      const contract = makeContract([prop1], [building]);
      const rent = BL.computeRent(contract, '01/01/2024 00:00', null);
      // Total charges = property expense (50) + building charge (100)
      expect(rent.total.charges).toBe(150);
      expect(rent.total.grandTotal).toBe(650); // rent (500) + charges (150)
    });

    it('should combine multiple building expenses', () => {
      const prop1 = makeProperty('prop1', 500);
      const unit1 = makeUnit('prop1', { general: 500, heating: 500 });
      const unit2 = { ...makeUnit('prop2', { general: 500, heating: 500 }), _id: 'unit2' };

      const expense1 = makeExpense('Cleaning', 200, 'general_thousandths');
      const expense2 = { ...makeExpense('Heating', 600, 'heating_thousandths'), _id: 'exp2' };
      const building = makeBuilding('011172', [unit1, unit2], [expense1, expense2]);

      const contract = makeContract([prop1], [building]);
      const rent = BL.computeRent(contract, '01/01/2024 00:00', null);

      expect(rent.buildingCharges).toHaveLength(2);
      // prop1 gets: 200 * 500/1000 (cleaning) + 600 * 500/1000 (heating) = 100 + 300 = 400
      expect(rent.total.charges).toBe(400);
    });
  });

  describe('Edge Cases', () => {
    it('should handle property not linked to building', () => {
      const prop1 = makeProperty('prop1', 500);

      const contract = makeContract([prop1], []); // No buildings
      const rent = BL.computeRent(contract, '01/01/2024 00:00', null);

      expect(rent.buildingCharges).toBeUndefined();
      expect(rent.total.charges).toBe(0);
    });

    it('should handle zero thousandths (unallocated unit)', () => {
      const prop1 = makeProperty('prop1', 500);
      const unit1 = makeUnit('prop1', { general: 0 });

      const expense = makeExpense('Cleaning', 1000, 'general_thousandths');
      const building = makeBuilding('011172', [unit1], [expense]);
      const contract = makeContract([prop1], [building]);
      const rent = BL.computeRent(contract, '01/01/2024 00:00', null);

      expect(rent.buildingCharges).toHaveLength(0); // Zero amounts are filtered out
    });

    it('should handle building with no expenses', () => {
      const prop1 = makeProperty('prop1', 500);
      const unit1 = makeUnit('prop1');
      const building = makeBuilding('011172', [unit1], []); // No expenses

      const contract = makeContract([prop1], [building]);
      const rent = BL.computeRent(contract, '01/01/2024 00:00', null);

      expect(rent.buildingCharges).toEqual([]);
    });
  });
});
