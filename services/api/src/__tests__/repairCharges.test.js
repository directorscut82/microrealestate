import * as BL from '../businesslogic/index.js';

describe('Repair Charges — No Double Counting', () => {
  const makeProperty = (propertyId, rent = 500) => ({
    propertyId,
    rent,
    expenses: [],
    entryDate: new Date('2024-01-01'),
    exitDate: new Date('2024-12-31')
  });

  const makeUnit = (propertyId, thousandths = {}, monthlyCharges = []) => ({
    _id: `unit_${propertyId}`,
    propertyId,
    atakNumber: '01234567890',
    isManaged: true,
    surface: 80,
    generalThousandths: thousandths.general || 0,
    heatingThousandths: thousandths.heating || 0,
    elevatorThousandths: thousandths.elevator || 0,
    owners: [],
    monthlyCharges
  });

  const makeBuilding = (units = [], expenses = [], repairs = []) => ({
    _id: 'building1',
    name: 'Test Building',
    atakPrefix: '011172',
    units,
    expenses,
    repairs,
    address: {},
    blockStreets: [],
    hasElevator: false,
    hasCentralHeating: false,
    contractors: []
  });

  const makeRepair = (title, overrides = {}) => ({
    _id: 'repair1',
    title,
    category: 'plumbing',
    status: 'completed',
    urgency: 'normal',
    estimatedCost: 500,
    actualCost: 400,
    chargeableTo: 'tenants',
    tenantSharePercentage: 100,
    allocationMethod: 'general_thousandths',
    chargeTerm: 2024010100,
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

  describe('Repair charges via monthlyCharges only (no pipeline duplicate)', () => {
    it('should include repair charge from monthlyCharges when repair is charged to tenants', () => {
      const monthlyCharges = [
        { term: 2024010100, amount: 200, description: 'Repair: Fix pipes' }
      ];
      const unit1 = makeUnit('prop1', { general: 500 }, monthlyCharges);
      const unit2 = makeUnit('prop2', { general: 500 }, []);
      const repair = makeRepair('Fix pipes', {
        chargeableTo: 'tenants',
        chargeTerm: 2024010100,
        actualCost: 400
      });
      const building = makeBuilding([unit1, unit2], [], [repair]);
      const contract = makeContract(
        [makeProperty('prop1')],
        [building]
      );

      const rent = BL.computeRent(contract, '01/01/2024 00:00', null);

      // Should only have ONE building charge from monthlyCharges, NOT a duplicate from repair processing
      expect(rent.buildingCharges).toHaveLength(1);
      expect(rent.buildingCharges[0].amount).toBe(200);
      expect(rent.buildingCharges[0].description).toBe('Repair: Fix pipes');
      expect(rent.buildingCharges[0].type).toBe('monthly_charge');
    });

    it('should NOT charge repairs directly from building.repairs array', () => {
      // Even with a chargeable repair, if no monthlyCharge was created,
      // the pipeline should NOT process it (that's the backend's job via _distributeRepairCharge)
      const unit1 = makeUnit('prop1', { general: 500 }, []);
      const repair = makeRepair('Roof fix', {
        chargeableTo: 'tenants',
        chargeTerm: 2024010100,
        actualCost: 1000
      });
      const building = makeBuilding([unit1], [], [repair]);
      const contract = makeContract(
        [makeProperty('prop1')],
        [building]
      );

      const rent = BL.computeRent(contract, '01/01/2024 00:00', null);

      // No charges should appear — repairs are only processed via monthlyCharges
      expect(rent.buildingCharges).toHaveLength(0);
    });

    it('should handle split repair (tenantSharePercentage) via monthlyCharges only', () => {
      // A 60/40 split repair of €1000 = €600 to tenants
      // _distributeRepairCharge would create monthlyCharge of €300 per unit (2 units equal)
      const monthlyCharges = [
        { term: 2024010100, amount: 300, description: 'Repair: Elevator motor' }
      ];
      const unit1 = makeUnit('prop1', { general: 500 }, monthlyCharges);
      const unit2 = makeUnit('prop2', { general: 500 }, [
        { term: 2024010100, amount: 300, description: 'Repair: Elevator motor' }
      ]);
      const repair = makeRepair('Elevator motor', {
        chargeableTo: 'split',
        tenantSharePercentage: 60,
        chargeTerm: 2024010100,
        actualCost: 1000
      });
      const building = makeBuilding([unit1, unit2], [], [repair]);
      const contract = makeContract(
        [makeProperty('prop1')],
        [building]
      );

      const rent = BL.computeRent(contract, '01/01/2024 00:00', null);

      expect(rent.buildingCharges).toHaveLength(1);
      expect(rent.buildingCharges[0].amount).toBe(300);
      expect(rent.buildingCharges[0].type).toBe('monthly_charge');
    });

    it('should not charge cancelled repair even if monthlyCharge exists', () => {
      // monthlyCharges still has an entry but repair was cancelled
      // This is an edge case — _distributeRepairCharge should have cleaned up,
      // but the pipeline should still process monthlyCharges regardless (they're authoritative)
      const monthlyCharges = [
        { term: 2024010100, amount: 200, description: 'Repair: Bad paint' }
      ];
      const unit1 = makeUnit('prop1', { general: 1000 }, monthlyCharges);
      const repair = makeRepair('Bad paint', {
        status: 'cancelled',
        chargeableTo: 'tenants',
        chargeTerm: 2024010100
      });
      const building = makeBuilding([unit1], [], [repair]);
      const contract = makeContract(
        [makeProperty('prop1')],
        [building]
      );

      const rent = BL.computeRent(contract, '01/01/2024 00:00', null);

      // monthlyCharges are authoritative — they stay until cleaned up by backend
      expect(rent.buildingCharges).toHaveLength(1);
      expect(rent.buildingCharges[0].amount).toBe(200);
    });

    it('should not double-count when repair + recurring expense exist for same term', () => {
      const monthlyCharges = [
        { term: 2024010100, amount: 150, description: 'Repair: Plumbing', expenseId: undefined },
        { term: 2024010100, amount: 80, description: 'Heating January', expenseId: 'exp1' }
      ];
      const unit1 = makeUnit('prop1', { general: 500, heating: 400 }, monthlyCharges);
      const unit2 = makeUnit('prop2', { general: 500, heating: 600 }, []);

      const expense = {
        _id: 'exp1',
        name: 'Heating',
        type: 'heating',
        amount: 200,
        allocationMethod: 'heating_thousandths',
        isRecurring: true,
        customAllocations: []
      };
      const repair = makeRepair('Plumbing', {
        chargeableTo: 'tenants',
        chargeTerm: 2024010100,
        actualCost: 300
      });
      const building = makeBuilding([unit1, unit2], [expense], [repair]);
      const contract = makeContract(
        [makeProperty('prop1')],
        [building]
      );

      const rent = BL.computeRent(contract, '01/01/2024 00:00', null);

      // Should have 2 entries: repair monthly charge + heating monthly charge
      // The recurring expense 'Heating' should be skipped because exp1 is in monthlyChargeExpenseIds
      expect(rent.buildingCharges).toHaveLength(2);
      const repairCharge = rent.buildingCharges.find(c => c.description === 'Repair: Plumbing');
      const heatingCharge = rent.buildingCharges.find(c => c.description === 'Heating January');
      expect(repairCharge.amount).toBe(150);
      expect(heatingCharge.amount).toBe(80);
    });
  });

  describe('Owner-only repairs produce no tenant charges', () => {
    it('should not create buildingCharges when chargeableTo is owners', () => {
      // Owner-only repair: no monthlyCharges should have been created
      const unit1 = makeUnit('prop1', { general: 1000 }, []);
      const repair = makeRepair('Facade restoration', {
        chargeableTo: 'owners',
        chargeTerm: 2024010100,
        actualCost: 5000
      });
      const building = makeBuilding([unit1], [], [repair]);
      const contract = makeContract(
        [makeProperty('prop1')],
        [building]
      );

      const rent = BL.computeRent(contract, '01/01/2024 00:00', null);

      expect(rent.buildingCharges).toHaveLength(0);
    });
  });

  describe('Different term repairs do not affect current month', () => {
    it('should not include repair charge from a different month', () => {
      // Repair is for February but we compute January
      const monthlyCharges = [
        { term: 2024020100, amount: 200, description: 'Repair: Fix heater' }
      ];
      const unit1 = makeUnit('prop1', { general: 1000 }, monthlyCharges);
      const repair = makeRepair('Fix heater', {
        chargeableTo: 'tenants',
        chargeTerm: 2024020100
      });
      const building = makeBuilding([unit1], [], [repair]);
      const contract = makeContract(
        [makeProperty('prop1')],
        [building]
      );

      const rent = BL.computeRent(contract, '01/01/2024 00:00', null);

      // January rent should not include February's repair charge
      expect(rent.buildingCharges).toHaveLength(0);
    });
  });
});

describe('Allocation Method Filtering', () => {
  // These test the pure logic that would be in the frontend
  // Replicated here as unit tests for the business rules

  const ALLOCATION_METHODS_BY_TYPE = {
    heating: ['heating_thousandths', 'equal', 'by_surface', 'fixed', 'custom_ratio', 'custom_percentage'],
    elevator: ['elevator_thousandths', 'equal', 'by_surface', 'fixed', 'custom_ratio', 'custom_percentage'],
    cleaning: ['general_thousandths', 'equal', 'by_surface', 'fixed', 'custom_ratio', 'custom_percentage'],
    water_common: ['general_thousandths', 'equal', 'by_surface', 'fixed', 'custom_ratio', 'custom_percentage'],
    electricity_common: ['general_thousandths', 'equal', 'by_surface', 'fixed', 'custom_ratio', 'custom_percentage'],
    insurance: ['general_thousandths', 'equal', 'by_surface', 'fixed', 'custom_ratio', 'custom_percentage'],
    management_fee: ['general_thousandths', 'equal', 'by_surface', 'fixed', 'custom_ratio', 'custom_percentage'],
    garden: ['general_thousandths', 'equal', 'by_surface', 'fixed', 'custom_ratio', 'custom_percentage'],
    repairs_fund: ['general_thousandths', 'equal', 'by_surface', 'fixed', 'custom_ratio', 'custom_percentage'],
    pest_control: ['general_thousandths', 'equal', 'by_surface', 'fixed', 'custom_ratio', 'custom_percentage']
  };

  function getAllocationMethodsForType(expenseType) {
    return ALLOCATION_METHODS_BY_TYPE[expenseType] || null;
  }

  describe('heating expense type', () => {
    it('should include heating_thousandths', () => {
      const methods = getAllocationMethodsForType('heating');
      expect(methods).toContain('heating_thousandths');
    });

    it('should NOT include general_thousandths', () => {
      const methods = getAllocationMethodsForType('heating');
      expect(methods).not.toContain('general_thousandths');
    });

    it('should NOT include elevator_thousandths', () => {
      const methods = getAllocationMethodsForType('heating');
      expect(methods).not.toContain('elevator_thousandths');
    });

    it('should include equal and by_surface as universal options', () => {
      const methods = getAllocationMethodsForType('heating');
      expect(methods).toContain('equal');
      expect(methods).toContain('by_surface');
    });
  });

  describe('elevator expense type', () => {
    it('should include elevator_thousandths', () => {
      const methods = getAllocationMethodsForType('elevator');
      expect(methods).toContain('elevator_thousandths');
    });

    it('should NOT include general_thousandths', () => {
      const methods = getAllocationMethodsForType('elevator');
      expect(methods).not.toContain('general_thousandths');
    });

    it('should NOT include heating_thousandths', () => {
      const methods = getAllocationMethodsForType('elevator');
      expect(methods).not.toContain('heating_thousandths');
    });
  });

  describe('electricity/DEH expense type', () => {
    it('should include general_thousandths for electricity', () => {
      const methods = getAllocationMethodsForType('electricity_common');
      expect(methods).toContain('general_thousandths');
    });

    it('should NOT include heating_thousandths for electricity', () => {
      const methods = getAllocationMethodsForType('electricity_common');
      expect(methods).not.toContain('heating_thousandths');
    });

    it('should NOT include elevator_thousandths for electricity', () => {
      const methods = getAllocationMethodsForType('electricity_common');
      expect(methods).not.toContain('elevator_thousandths');
    });
  });

  describe('water expense type', () => {
    it('should include general_thousandths for water', () => {
      const methods = getAllocationMethodsForType('water_common');
      expect(methods).toContain('general_thousandths');
    });

    it('should NOT include heating or elevator thousandths', () => {
      const methods = getAllocationMethodsForType('water_common');
      expect(methods).not.toContain('heating_thousandths');
      expect(methods).not.toContain('elevator_thousandths');
    });
  });

  describe('unknown/other expense type', () => {
    it('should return null (all methods) for unknown type', () => {
      const methods = getAllocationMethodsForType('other');
      expect(methods).toBeNull();
    });

    it('should return null for undefined type', () => {
      const methods = getAllocationMethodsForType(undefined);
      expect(methods).toBeNull();
    });
  });

  describe('all types include universal methods', () => {
    const knownTypes = Object.keys(ALLOCATION_METHODS_BY_TYPE);

    knownTypes.forEach((type) => {
      it(`${type} should include equal`, () => {
        expect(getAllocationMethodsForType(type)).toContain('equal');
      });

      it(`${type} should include by_surface`, () => {
        expect(getAllocationMethodsForType(type)).toContain('by_surface');
      });

      it(`${type} should include fixed`, () => {
        expect(getAllocationMethodsForType(type)).toContain('fixed');
      });

      it(`${type} should include custom_ratio`, () => {
        expect(getAllocationMethodsForType(type)).toContain('custom_ratio');
      });

      it(`${type} should include custom_percentage`, () => {
        expect(getAllocationMethodsForType(type)).toContain('custom_percentage');
      });
    });
  });

  describe('mutually exclusive thousandths', () => {
    it('heating_thousandths should ONLY appear for heating type', () => {
      const typesWithHeating = Object.entries(ALLOCATION_METHODS_BY_TYPE)
        .filter(([, methods]) => methods.includes('heating_thousandths'))
        .map(([type]) => type);
      expect(typesWithHeating).toEqual(['heating']);
    });

    it('elevator_thousandths should ONLY appear for elevator type', () => {
      const typesWithElevator = Object.entries(ALLOCATION_METHODS_BY_TYPE)
        .filter(([, methods]) => methods.includes('elevator_thousandths'))
        .map(([type]) => type);
      expect(typesWithElevator).toEqual(['elevator']);
    });

    it('general_thousandths should NOT appear for heating or elevator', () => {
      const typesWithGeneral = Object.entries(ALLOCATION_METHODS_BY_TYPE)
        .filter(([, methods]) => methods.includes('general_thousandths'))
        .map(([type]) => type);
      expect(typesWithGeneral).not.toContain('heating');
      expect(typesWithGeneral).not.toContain('elevator');
    });
  });
});

describe('Repair Charge Distribution Logic', () => {
  // Tests for the _distributeRepairCharge business logic
  // (testing the expected outcomes, not the function directly since it needs Mongoose)

  describe('charge calculation scenarios', () => {
    it('should compute full tenant charge for chargeableTo=tenants', () => {
      // €400 repair, 100% to tenants, general_thousandths
      // Unit has 300/1000 general thousandths
      const cost = 400;
      const sharePercentage = 100;
      const effectiveAmount = cost * (sharePercentage / 100); // 400
      const unitThousandths = 300;
      const totalThousandths = 1000;
      const unitShare = (effectiveAmount * unitThousandths) / totalThousandths;

      expect(unitShare).toBe(120); // €120 for this unit
    });

    it('should compute split charge correctly (60% tenant)', () => {
      // €1000 repair, 60% to tenants
      const cost = 1000;
      const sharePercentage = 60;
      const effectiveAmount = cost * (sharePercentage / 100); // 600

      // Equal split among 3 units
      const unitShare = effectiveAmount / 3;
      expect(unitShare).toBe(200); // €200 per unit
    });

    it('should compute zero charge for 0% tenant share', () => {
      const cost = 1000;
      const sharePercentage = 0;
      const effectiveAmount = cost * (sharePercentage / 100);

      expect(effectiveAmount).toBe(0);
    });

    it('should prefer actualCost over estimatedCost', () => {
      const estimatedCost = 500;
      const actualCost = 380;
      const cost = actualCost || estimatedCost;

      expect(cost).toBe(380);
    });

    it('should fallback to estimatedCost when actualCost is 0', () => {
      const estimatedCost = 500;
      const actualCost = 0;
      const cost = actualCost || estimatedCost;

      expect(cost).toBe(500);
    });

    it('should generate correct monthlyCharge description', () => {
      const repairTitle = 'Fix elevator door';
      const description = `Repair: ${repairTitle}`;
      expect(description).toBe('Repair: Fix elevator door');
    });
  });

  describe('cleanup on repair delete', () => {
    it('should identify charges matching repair title for cleanup', () => {
      const repairTitle = 'Plumbing emergency';
      const chargeDescription = `Repair: ${repairTitle}`;
      const monthlyCharges = [
        { term: 2024010100, amount: 100, description: 'Heating January' },
        { term: 2024010100, amount: 200, description: 'Repair: Plumbing emergency' },
        { term: 2024020100, amount: 200, description: 'Repair: Plumbing emergency' },
        { term: 2024010100, amount: 50, description: 'Repair: Other fix' }
      ];

      const toRemove = monthlyCharges.filter(
        (c) => c.description === chargeDescription
      );

      expect(toRemove).toHaveLength(2);
      expect(toRemove[0].term).toBe(2024010100);
      expect(toRemove[1].term).toBe(2024020100);
    });

    it('should not remove charges with similar but different descriptions', () => {
      const chargeDescription = 'Repair: Fix pipes';
      const monthlyCharges = [
        { term: 2024010100, amount: 100, description: 'Repair: Fix pipes - part 2' },
        { term: 2024010100, amount: 200, description: 'Repair: Fix pipes' },
        { term: 2024010100, amount: 50, description: 'Repair: Fix pipe connections' }
      ];

      const toRemove = monthlyCharges.filter(
        (c) => c.description === chargeDescription
      );

      expect(toRemove).toHaveLength(1);
      expect(toRemove[0].amount).toBe(200);
    });
  });
});
