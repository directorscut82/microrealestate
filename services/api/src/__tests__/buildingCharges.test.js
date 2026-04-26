import { computeRent } from '../businesslogic/index.js';

// Factory functions for test data
function makeContract(overrides = {}) {
  return {
    begin: new Date('2026-01-01'),
    end: new Date('2026-12-31'),
    frequency: 'months',
    properties: [],
    buildings: [],
    vatRate: 0,
    discount: 0,
    rents: [],
    ...overrides
  };
}

function makeBuilding(overrides = {}) {
  return {
    _id: 'building1',
    realmId: 'realm1',
    name: 'Building Test',
    atakPrefix: '011172',
    address: {
      street1: 'Test St 1',
      zipCode: '12345',
      city: 'Test City',
      state: 'Test State',
      country: 'GR'
    },
    blockNumber: '58',
    blockStreets: [],
    yearBuilt: 1985,
    hasElevator: false,
    hasCentralHeating: false,
    units: [],
    expenses: [],
    contractors: [],
    repairs: [],
    ...overrides
  };
}

function makeUnit(overrides = {}) {
  return {
    _id: 'unit1',
    atakNumber: '01117260169',
    floor: 1,
    surface: 72,
    generalThousandths: 300,
    heatingThousandths: 300,
    elevatorThousandths: 0,
    owners: [{ type: 'member', percentage: 100 }],
    propertyId: 'prop1',
    isManaged: true,
    monthlyCharges: [],
    ...overrides
  };
}

function makeProperty(overrides = {}) {
  return {
    propertyId: 'prop1',
    rent: 500,
    entryDate: new Date('2026-01-01'),
    exitDate: new Date('2026-12-31'),
    expenses: [],
    property: {
      _id: 'prop1',
      name: 'Property 1',
      price: 500
    },
    ...overrides
  };
}

function makeExpense(overrides = {}) {
  return {
    _id: 'expense1',
    name: 'Heating',
    type: 'heating',
    amount: 600,
    allocationMethod: 'heating_thousandths',
    customAllocations: [],
    isRecurring: true,
    ...overrides
  };
}

describe('Building charge computation', () => {
  describe('thousandths allocation', () => {
    it('should allocate heating expense by heating thousandths', () => {
      const unit1 = makeUnit({
        propertyId: 'prop1',
        heatingThousandths: 300
      });
      const unit2 = makeUnit({
        _id: 'unit2',
        propertyId: 'prop2',
        heatingThousandths: 700
      });

      const building = makeBuilding({
        units: [unit1, unit2],
        expenses: [
          makeExpense({
            name: 'Heating',
            type: 'heating',
            amount: 1000,
            allocationMethod: 'heating_thousandths'
          })
        ]
      });

      const contract = makeContract({
        properties: [
          makeProperty({ propertyId: 'prop1' }),
          makeProperty({ propertyId: 'prop2' })
        ],
        buildings: [building]
      });

      const rent = computeRent(contract, '01/01/2026 00:00', null);

      expect(rent.buildingCharges).toBeDefined();
      expect(rent.buildingCharges?.length).toBe(2);

      // Unit 1: 1000 * 300/1000 = 300
      const charge1 = rent.buildingCharges?.find(
        (c) => c.description === 'Heating'
      );
      expect(charge1).toBeDefined();

      // Total charges should be 300 + 700 = 1000
      const totalBuildingCharges = rent.buildingCharges.reduce(
        (sum, c) => sum + c.amount,
        0
      );
      expect(totalBuildingCharges).toBe(1000);
    });

    it('should handle zero total thousandths gracefully', () => {
      const unit1 = makeUnit({
        propertyId: 'prop1',
        heatingThousandths: 0
      });

      const building = makeBuilding({
        units: [unit1],
        expenses: [
          makeExpense({
            amount: 600,
            allocationMethod: 'heating_thousandths'
          })
        ]
      });

      const contract = makeContract({
        properties: [makeProperty({ propertyId: 'prop1' })],
        buildings: [building]
      });

      const rent = computeRent(contract, '01/01/2026 00:00', null);

      // Should not crash, charge should be 0
      expect(rent.buildingCharges).toBeDefined();
      expect(rent.buildingCharges?.length).toBe(0);
    });

    it('should allocate general expense by general thousandths', () => {
      const unit1 = makeUnit({
        propertyId: 'prop1',
        generalThousandths: 500
      });

      const building = makeBuilding({
        units: [unit1],
        expenses: [
          makeExpense({
            name: 'Cleaning',
            type: 'cleaning',
            amount: 200,
            allocationMethod: 'general_thousandths'
          })
        ]
      });

      const contract = makeContract({
        properties: [makeProperty({ propertyId: 'prop1' })],
        buildings: [building]
      });

      const rent = computeRent(contract, '01/01/2026 00:00', null);

      const cleaning = rent.buildingCharges?.find((c) => c.description === 'Cleaning');
      expect(cleaning).toBeDefined();
      // 200 * 500/500 = 200 (only one unit)
      expect(cleaning?.amount).toBe(200);
    });
  });

  describe('equal allocation', () => {
    it('should split expense equally among managed units', () => {
      const unit1 = makeUnit({ propertyId: 'prop1', isManaged: true });
      const unit2 = makeUnit({
        _id: 'unit2',
        propertyId: 'prop2',
        isManaged: true
      });
      const unit3 = makeUnit({
        _id: 'unit3',
        propertyId: 'prop3',
        isManaged: false
      });

      const building = makeBuilding({
        units: [unit1, unit2, unit3],
        expenses: [
          makeExpense({
            name: 'Pest Control',
            type: 'pest_control',
            amount: 100,
            allocationMethod: 'equal'
          })
        ]
      });

      const contract = makeContract({
        properties: [
          makeProperty({ propertyId: 'prop1' }),
          makeProperty({ propertyId: 'prop2' })
        ],
        buildings: [building]
      });

      const rent = computeRent(contract, '01/01/2026 00:00', null);

      // Should be split only between managed units (2), not unmanaged (1)
      const charges = rent.buildingCharges.filter(
        (c) => c.description === 'Pest Control'
      );
      expect(charges.length).toBe(2);
      charges.forEach((c) => {
        expect(c.amount).toBe(50); // 100 / 2 managed units
      });
    });
  });

  describe('by surface allocation', () => {
    it('should allocate by surface area', () => {
      const unit1 = makeUnit({ propertyId: 'prop1', surface: 72 });
      const unit2 = makeUnit({
        _id: 'unit2',
        propertyId: 'prop2',
        surface: 48
      });

      const building = makeBuilding({
        units: [unit1, unit2],
        expenses: [
          makeExpense({
            name: 'Insurance',
            type: 'insurance',
            amount: 1200,
            allocationMethod: 'by_surface'
          })
        ]
      });

      const contract = makeContract({
        properties: [
          makeProperty({ propertyId: 'prop1' }),
          makeProperty({ propertyId: 'prop2' })
        ],
        buildings: [building]
      });

      const rent = computeRent(contract, '01/01/2026 00:00', null);

      const totalSurface = 72 + 48; // 120
      const expected1 = (1200 * 72) / 120; // 720
      const expected2 = (1200 * 48) / 120; // 480

      const charges = rent.buildingCharges;
      expect(charges.length).toBe(2);
      expect(charges.reduce((sum, c) => sum + c.amount, 0)).toBe(1200);
    });
  });

  describe('custom allocation', () => {
    it('should use custom ratio allocation', () => {
      const unit1 = makeUnit({ propertyId: 'prop1' });
      const unit2 = makeUnit({ _id: 'unit2', propertyId: 'prop2' });

      const building = makeBuilding({
        units: [unit1, unit2],
        expenses: [
          makeExpense({
            name: 'Special Assessment',
            type: 'other',
            amount: 1000,
            allocationMethod: 'custom_ratio',
            customAllocations: [
              { propertyId: 'prop1', value: 2 },
              { propertyId: 'prop2', value: 3 }
            ]
          })
        ]
      });

      const contract = makeContract({
        properties: [
          makeProperty({ propertyId: 'prop1' }),
          makeProperty({ propertyId: 'prop2' })
        ],
        buildings: [building]
      });

      const rent = computeRent(contract, '01/01/2026 00:00', null);

      // Ratio 2:3 means unit1 gets 2/(2+3) = 40%, unit2 gets 3/(2+3) = 60%
      const charges = rent.buildingCharges;
      expect(charges.length).toBe(2);
      expect(charges.reduce((sum, c) => sum + c.amount, 0)).toBe(1000);
    });

    it('should use custom percentage allocation', () => {
      const unit1 = makeUnit({ propertyId: 'prop1' });
      const unit2 = makeUnit({ _id: 'unit2', propertyId: 'prop2' });

      const building = makeBuilding({
        units: [unit1, unit2],
        expenses: [
          makeExpense({
            name: 'Custom Charge',
            type: 'other',
            amount: 500,
            allocationMethod: 'custom_percentage',
            customAllocations: [
              { propertyId: 'prop1', value: 30 },
              { propertyId: 'prop2', value: 70 }
            ]
          })
        ]
      });

      const contract = makeContract({
        properties: [
          makeProperty({ propertyId: 'prop1' }),
          makeProperty({ propertyId: 'prop2' })
        ],
        buildings: [building]
      });

      const rent = computeRent(contract, '01/01/2026 00:00', null);

      const charges = rent.buildingCharges;
      expect(charges.length).toBe(2);
      // Should be exactly 30% and 70%
      expect(charges.reduce((sum, c) => sum + c.amount, 0)).toBe(500);
    });
  });

  describe('monthly charges', () => {
    it('should add monthly charges for specific term', () => {
      const unit1 = makeUnit({
        propertyId: 'prop1',
        monthlyCharges: [
          {
            _id: 'charge1',
            term: 2026010100, // January 2026
            amount: 80,
            description: 'Extra charge'
          }
        ]
      });

      const building = makeBuilding({ units: [unit1] });

      const contract = makeContract({
        properties: [makeProperty({ propertyId: 'prop1' })],
        buildings: [building]
      });

      const rent = computeRent(contract, '01/01/2026 00:00', null);

      const monthlyCharge = rent.buildingCharges?.find(
        (c) => c.description === 'Extra charge'
      );
      expect(monthlyCharge).toBeDefined();
      expect(monthlyCharge?.amount).toBe(80);
    });

    it('should not add monthly charges for different term', () => {
      const unit1 = makeUnit({
        propertyId: 'prop1',
        monthlyCharges: [
          {
            _id: 'charge1',
            term: 2026020100, // February 2026
            amount: 80,
            description: 'February charge'
          }
        ]
      });

      const building = makeBuilding({ units: [unit1] });

      const contract = makeContract({
        properties: [makeProperty({ propertyId: 'prop1' })],
        buildings: [building]
      });

      // Compute rent for January
      const rent = computeRent(contract, '01/01/2026 00:00', null);

      const monthlyCharge = rent.buildingCharges?.find(
        (c) => c.description === 'February charge'
      );
      expect(monthlyCharge).toBeUndefined();
    });
  });

  describe('expense term filtering', () => {
    it('should include recurring expenses without start/end terms', () => {
      const unit1 = makeUnit({ propertyId: 'prop1' });
      const building = makeBuilding({
        units: [unit1],
        expenses: [
          makeExpense({
            isRecurring: true,
            startTerm: undefined,
            endTerm: undefined
          })
        ]
      });

      const contract = makeContract({
        properties: [makeProperty({ propertyId: 'prop1' })],
        buildings: [building]
      });

      const rent = computeRent(contract, '01/01/2026 00:00', null);

      expect(rent.buildingCharges?.length).toBeGreaterThan(0);
    });

    it('should exclude expenses before start term', () => {
      const unit1 = makeUnit({ propertyId: 'prop1' });
      const building = makeBuilding({
        units: [unit1],
        expenses: [
          makeExpense({
            isRecurring: true,
            startTerm: 2026020100 // Starts February
          })
        ]
      });

      const contract = makeContract({
        properties: [makeProperty({ propertyId: 'prop1' })],
        buildings: [building]
      });

      // Compute rent for January - should not include expense
      const rent = computeRent(contract, '01/01/2026 00:00', null);

      expect(rent.buildingCharges?.length).toBe(0);
    });

    it('should exclude expenses after end term', () => {
      const unit1 = makeUnit({ propertyId: 'prop1' });
      const building = makeBuilding({
        units: [unit1],
        expenses: [
          makeExpense({
            isRecurring: true,
            endTerm: 2025123100 // Ended December 2025
          })
        ]
      });

      const contract = makeContract({
        properties: [makeProperty({ propertyId: 'prop1' })],
        buildings: [building]
      });

      // Compute rent for January 2026 - should not include expense
      const rent = computeRent(contract, '01/01/2026 00:00', null);

      expect(rent.buildingCharges?.length).toBe(0);
    });
  });

  describe('total computation', () => {
    it('should include building charges in total charges', () => {
      const unit1 = makeUnit({ propertyId: 'prop1', generalThousandths: 1000 });
      const building = makeBuilding({
        units: [unit1],
        expenses: [
          makeExpense({
            name: 'Cleaning',
            amount: 100,
            allocationMethod: 'general_thousandths'
          })
        ]
      });

      const contract = makeContract({
        properties: [
          makeProperty({
            propertyId: 'prop1',
            rent: 500,
            expenses: [
              {
                title: 'Property Expense',
                amount: 50,
                beginDate: new Date('2026-01-01'),
                endDate: new Date('2026-12-31')
              }
            ]
          })
        ],
        buildings: [building]
      });

      const rent = computeRent(contract, '01/01/2026 00:00', null);

      // Verify building charges exist
      expect(rent.buildingCharges?.length).toBeGreaterThan(0);

      // Property-level charges: 50
      // Building charges: 100
      // Total charges: 150
      expect(rent.total.charges).toBe(150);
    });
  });
});
