import type { CollectionTypes } from '@microrealestate/types';
import moment from 'moment';

export interface Contract {
  begin: Date;
  end: Date;
  termination?: Date;
  frequency: string;
  terms?: number;
  properties: CollectionTypes.Tenant['properties'];
  buildings?: CollectionTypes.Building[];  // Building data for charge computation
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
  buildingCharges?: { description: string; amount: number; buildingName?: string; type?: string }[];
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

// Helper to compute building charge share for a property
export function computeBuildingChargeForProperty(
  building: CollectionTypes.Building,
  propertyId: string,
  expense: CollectionTypes.BuildingExpense
): number {
  return Math.round(_computeBuildingChargeRaw(building, propertyId, expense) * 100) / 100;
}

function _computeBuildingChargeRaw(
  building: CollectionTypes.Building,
  propertyId: string,
  expense: CollectionTypes.BuildingExpense
): number {
  // Find the unit in the building
  const unit = building.units.find((u) => String(u.propertyId) === String(propertyId));
  if (!unit) return 0;

  const { allocationMethod, amount, customAllocations } = expense;

  switch (allocationMethod) {
    case 'general_thousandths': {
      const generalTotal = building.units.reduce((sum, u) => sum + (u.generalThousandths || 0), 0);
      if (generalTotal === 0) return 0;
      return (amount * (unit.generalThousandths || 0)) / generalTotal;
    }

    case 'heating_thousandths': {
      const heatingTotal = building.units.reduce((sum, u) => sum + (u.heatingThousandths || 0), 0);
      if (heatingTotal === 0) return 0;
      return (amount * (unit.heatingThousandths || 0)) / heatingTotal;
    }

    case 'elevator_thousandths': {
      const elevatorTotal = building.units.reduce((sum, u) => sum + (u.elevatorThousandths || 0), 0);
      if (elevatorTotal === 0) return 0;
      return (amount * (unit.elevatorThousandths || 0)) / elevatorTotal;
    }

    case 'equal': {
      const totalUnits = building.units.length;
      if (totalUnits === 0) return 0;
      return amount / totalUnits;
    }

    case 'by_surface': {
      const totalSurface = building.units.reduce((sum, u) => sum + (u.surface || 0), 0);
      if (totalSurface === 0) return 0;
      return (amount * (unit.surface || 0)) / totalSurface;
    }

    case 'fixed': {
      // Fixed allocation per unit
      const allocation = customAllocations?.find((a) => String(a.propertyId) === String(propertyId));
      return allocation?.value || 0;
    }

    case 'custom_ratio': {
      // Custom ratio - normalize to sum
      const unitsWithProperty = building.units.filter((u) => u.propertyId);
      const totalRatio = customAllocations?.reduce((sum, a) => sum + (a.value || 0), 0) || 0;
      const allocation = customAllocations?.find((a) => String(a.propertyId) === String(propertyId));
      // Single-unit fallback: if no ratios set and only 1 unit, give full amount
      if (totalRatio === 0) return unitsWithProperty.length === 1 ? amount : 0;
      if (!allocation) return 0;
      return (amount * allocation.value) / totalRatio;
    }

    case 'custom_percentage': {
      // Custom percentage - value is already a percentage
      const allocation = customAllocations?.find((a) => String(a.propertyId) === String(propertyId));
      if (!allocation) return 0;
      return (amount * allocation.value) / 100;
    }

    default:
      return 0;
  }
}

// Check if expense is active for the given term
function isExpenseActiveForTerm(expense: CollectionTypes.BuildingExpense, term: number): boolean {
  // Non-recurring expenses only apply to their start term
  if (!(expense as any).isRecurring && expense.startTerm && expense.startTerm !== term) return false;
  if (expense.startTerm && term < expense.startTerm) return false;
  if (expense.endTerm && term > expense.endTerm) return false;
  return true;
}

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

  // Always initialize buildingCharges
  rent.buildingCharges = [];

  if (contract.buildings && contract.buildings.length > 0) {
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
      .forEach((property) => {
        if (!property.propertyId) return;

        // Find building for this property
        const building = contract.buildings!.find((b) =>
          b.units.some((u) => String(u.propertyId) === String(property.propertyId))
        );

        if (!building) return;

        // Process monthly charges for this unit (overrides recurring expenses)
        const unit = building.units.find((u) => String(u.propertyId) === String(property.propertyId));
        const monthlyChargeExpenseIds = new Set<string>();
        if (unit) {
          unit.monthlyCharges
            .filter((charge) => charge.term === rent.term)
            .forEach((charge) => {
              if (charge.expenseId) monthlyChargeExpenseIds.add(String(charge.expenseId));
              rent.buildingCharges!.push({
                description: charge.description || 'Building charges',
                amount: charge.amount,
                buildingName: building.name,
                type: 'monthly_charge'
              });
            });
        }

        // Process recurring building expenses (skip those overridden by monthly charges)
        building.expenses
          .filter((expense) =>
            isExpenseActiveForTerm(expense, rent.term) &&
            !monthlyChargeExpenseIds.has(String(expense._id))
          )
          .forEach((expense) => {
            const share = computeBuildingChargeForProperty(
              building,
              String(property.propertyId),
              expense
            );

            if (share > 0) {
              rent.buildingCharges!.push({
                description: expense.name,
                amount: share,
                buildingName: building.name,
                type: expense.type
              });
            }
          });

      });
  }

  if (settlements) {
    rent.description = settlements.description || '';
  }
  return rent;
}
