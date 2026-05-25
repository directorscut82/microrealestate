import type { CollectionTypes } from '@microrealestate/types';
import { logger } from '@microrealestate/common';
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
  if (!building?.units || !Array.isArray(building.units)) return 0;

  const unit = building.units.find(
    (u) => String(u.propertyId) === String(propertyId)
  );
  if (!unit) return 0;

  const { allocationMethod, amount, customAllocations } = expense;
  // For non-fixed methods, amount must be a valid positive number
  if (allocationMethod !== 'fixed' && (!Number.isFinite(amount) || amount <= 0)) return 0;

  // Many allocation methods must only count "managed" units (those with a
  // linked propertyId). Unmanaged units inflate the denominator and silently
  // shrink every managed unit's share, leaking money out of the building's
  // recoverable charges.
  const managedUnits = building.units.filter((u) => u.propertyId);

  switch (allocationMethod) {
    case 'general_thousandths': {
      // Wave-14 F2: use the FULL building denominator (sum across ALL units,
      // including vacant) so each tenant pays exactly their pro-rata share.
      // The vacant unit's share is implicitly absorbed by the owner — it is
      // never associated with a tenant property, so it never lands on a bill.
      const generalTotal = building.units.reduce((sum, u) => sum + (Number(u.generalThousandths) || 0), 0);
      if (generalTotal === 0) return 0;
      return (amount * (Number(unit.generalThousandths) || 0)) / generalTotal;
    }

    case 'heating_thousandths': {
      // Wave-14 F2: see general_thousandths note.
      const heatingTotal = building.units.reduce((sum, u) => sum + (Number(u.heatingThousandths) || 0), 0);
      if (heatingTotal === 0) return 0;
      return (amount * (Number(unit.heatingThousandths) || 0)) / heatingTotal;
    }

    case 'elevator_thousandths': {
      // Wave-14 F2: see general_thousandths note.
      const elevatorTotal = building.units.reduce((sum, u) => sum + (Number(u.elevatorThousandths) || 0), 0);
      if (elevatorTotal === 0) return 0;
      return (amount * (Number(unit.elevatorThousandths) || 0)) / elevatorTotal;
    }

    case 'equal': {
      const totalUnits = managedUnits.length;
      if (totalUnits === 0) return 0;
      // Wave-14 F1: the per-unit share is round2(amount/n), but n equal
      // shares of round2(amount/n) under-recover the original amount when
      // it doesn't divide cleanly. Push the rounding remainder onto the
      // LAST managed unit (deterministic by sorted propertyId) so the
      // total reconciles. Example: 100/3 → 33.33+33.33+33.34 = 100.00.
      const base = Math.round((amount / totalUnits) * 100) / 100;
      const sortedIds = managedUnits
        .map((u) => String(u.propertyId))
        .sort();
      if (String(propertyId) === sortedIds[sortedIds.length - 1]) {
        return Math.round((amount - base * (totalUnits - 1)) * 100) / 100;
      }
      return base;
    }

    case 'by_surface': {
      const totalSurface = building.units.reduce((sum, u) => sum + (Number(u.surface) || 0), 0);
      if (totalSurface === 0) return 0;
      return (amount * (Number(unit.surface) || 0)) / totalSurface;
    }

    case 'fixed': {
      // Fixed allocation per unit. Negative values are misconfiguration
      // (a "negative fixed share") — log and clamp to 0 instead of silently
      // accepting them or letting them bubble into the rent total.
      const allocation = customAllocations?.find((a) => String(a.propertyId) === String(propertyId));
      const v = Number(allocation?.value);
      if (Number.isFinite(v) && v < 0) {
        logger.warn(
          `Fixed allocation has negative value (${v}) for property ${propertyId} ` +
            `in building ${building._id}; clamping to 0.`
        );
      }
      return Math.max(0, Number.isFinite(v) ? v : 0);
    }

    case 'custom_ratio': {
      // Custom ratio — normalize to sum.
      // Single-unit fallback: if NO ratios are configured but the building
      // has exactly one unit, that unit takes the full amount. With more
      // than one unit and no ratios we cannot infer a split, so we return
      // 0 and surface the misconfiguration in logs for the operator.
      const unitsWithProperty = building.units.filter((u) => u.propertyId);
      const totalRatio = customAllocations?.reduce((sum, a) => sum + (Number(a.value) || 0), 0) || 0;
      const allocation = customAllocations?.find((a) => String(a.propertyId) === String(propertyId));
      if (totalRatio === 0) {
        if (unitsWithProperty.length === 1) return amount;
        logger.warn(
          `custom_ratio allocation has no ratios set for building ${building._id} ` +
            `(${unitsWithProperty.length} units). Returning 0 share for property ${propertyId}.`
        );
        return 0;
      }
      if (!allocation) return 0;
      const av = Number(allocation.value) || 0;
      return (amount * av) / totalRatio;
    }

    case 'custom_percentage': {
      // Custom percentage - value is already a percentage
      const allocation = customAllocations?.find((a) => String(a.propertyId) === String(propertyId));
      if (!allocation) return 0;
      const pct = Number(allocation.value) || 0;
      return pct > 0 ? (amount * pct) / 100 : 0;
    }

    default:
      return 0;
  }
}

// Check if expense is active for the given term
function isExpenseActiveForTerm(expense: CollectionTypes.BuildingExpense, term: number): boolean {
  // Non-recurring expenses MUST have an explicit startTerm — without one
  // they would otherwise be treated as "active forever" by the date-range
  // checks below, which is the opposite of the intended behavior. Reject
  // them so misconfigured one-shot expenses don't silently bill every
  // term until end of time.
  if (!(expense as any).isRecurring) {
    if (!expense.startTerm) return false;
    if (expense.startTerm !== term) return false;
  }
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
  const currentMoment = moment.utc(rentDate, 'DD/MM/YYYY HH:mm');
  if (!currentMoment.isValid()) return rent;

  rent.term = Number(currentMoment.format('YYYYMMDDHH'));
  if (contract.frequency === 'months') {
    // NOTE: contract.ts uses startOf('month') so mid-month begin/end dates
    // produce a full-month rent (a tenant who moves in on the 20th is
    // billed the full month for that month). If proration is required,
    // change here to compute partial-month rent based on
    // day-of-month / daysInMonth — and apply the same scaling in
    // 2_amount.ts where preTaxAmount is computed.
    rent.term = Number(
      moment.utc(currentMoment).startOf('month').format('YYYYMMDDHH')
    );
  }
  if (contract.frequency === 'days') {
    rent.term = Number(
      moment.utc(currentMoment).startOf('day').format('YYYYMMDDHH')
    );
  }
  if (contract.frequency === 'hours') {
    rent.term = Number(
      moment.utc(currentMoment).startOf('hour').format('YYYYMMDDHH')
    );
  }
  rent.month = currentMoment.month() + 1;
  rent.year = currentMoment.year();

  const properties = contract.properties || [];

  properties
    .filter((property) => {
      const entryMoment = moment.utc(property.entryDate).startOf('day');
      const exitMoment = moment.utc(property.exitDate).endOf('day');

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
        const preTaxAmount = Math.round((Number(property.rent) || 0) * 100) / 100;
        const expenses = property.expenses || [];

        rent.preTaxAmounts.push({
          description: name,
          amount: preTaxAmount
        });

        if (expenses.length) {
          rent.charges.push(
            ...expenses
              .filter(({ beginDate, endDate }) => {
                const expenseBegin = moment.utc(beginDate, 'DD/MM/YYYY').startOf(
                  'day'
                );
                const expenseEnd = moment.utc(endDate, 'DD/MM/YYYY').endOf('day');

                return currentMoment.isBetween(
                  expenseBegin,
                  expenseEnd,
                  contract.frequency as moment.unitOfTime.StartOf,
                  '[]'
                );
              })
              .map(({ title, amount }) => ({
                description: title,
                amount: Math.round((Number(amount) || 0) * 100) / 100
              }))
          );
        }

      }
    });

  // Always initialize buildingCharges
  rent.buildingCharges = [];

  if (contract.buildings && contract.buildings.length > 0) {
    properties
      .filter((property) => {
        const entryMoment = moment.utc(property.entryDate).startOf('day');
        const exitMoment = moment.utc(property.exitDate).endOf('day');

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
