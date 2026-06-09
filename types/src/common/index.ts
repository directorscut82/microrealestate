export * from './collections.js';
export * from './environmentvalues.js';
export * from './locales.js';
export * from './redisclient.js';
export * from './service.js';

export type ConnectionRole = 'administrator' | 'renter' | 'tenant';
export type UserRole = Exclude<ConnectionRole, 'tenant'>;
export type ConnectionType = 'service' | 'user' | 'application'; // 'service' is for internal services, 'user' is for users, 'application' is for external applications

// Aligned to runtime values used by the rent manager
// (services/api/src/managers/rentmanager.ts PAYMENT_TYPES) and the
// frontend zod enum (PaymentTabs.js paymentSchema). Previously listed
// 'check' which never matched what the codebase actually persisted —
// stored payments use 'cheque'. 'levy' is also accepted by the API,
// kept here for legacy records.
export type PaymentMethod =
  | 'transfer'
  | 'credit-card'
  | 'cash'
  | 'cheque'
  | 'levy'
  | '';
export type PaymentStatus = 'paid' | 'partially-paid' | 'unpaid';
export type LeaseStatus = 'active' | 'ended' | 'terminated';
export type LeaseTimeRange = 'days' | 'weeks' | 'months' | 'years';

export type AllocationMethod =
  | 'general_thousandths'
  | 'heating_thousandths'
  | 'elevator_thousandths'
  | 'equal'
  | 'by_surface'
  | 'fixed'
  | 'custom_ratio'
  | 'custom_percentage'
  | 'single_unit';

export type ExpenseType =
  | 'heating'
  | 'elevator'
  | 'cleaning'
  | 'water_common'
  | 'electricity_common'
  | 'insurance'
  | 'management_fee'
  | 'garden'
  | 'repairs_fund'
  | 'pest_control'
  | 'other';

export type HeatingType =
  | 'central_oil'
  | 'central_gas'
  | 'autonomous'
  | 'none';

export type UnitOwnerType = 'member' | 'external';

export type OccupancyType = 'rented' | 'owner_occupied' | 'vacant' | 'parking';

export type ContractorSpecialty =
  // Legacy values kept for backwards compatibility with imported data.
  | 'plumbing'
  | 'electrical'
  // Canonical specialty names.
  | 'plumber'
  | 'electrician'
  | 'painter'
  | 'carpenter'
  | 'mason'
  | 'gardener'
  | 'cleaner'
  | 'elevator'
  | 'locksmith'
  | 'hvac'
  | 'general'
  | 'other';

export type RepairCategory =
  | 'plumbing'
  | 'electrical'
  | 'elevator'
  | 'roof'
  | 'facade'
  | 'heating'
  | 'doors_windows'
  | 'painting'
  | 'flooring'
  | 'general'
  | 'other';

export type RepairStatus =
  | 'planned'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

export type RepairUrgency = 'emergency' | 'normal' | 'low';
