export * from './collections.js';
export * from './environmentvalues.js';
export * from './locales.js';
export * from './redisclient.js';
export * from './service.js';

export type ConnectionRole = 'administrator' | 'renter' | 'tenant';
export type UserRole = Exclude<ConnectionRole, 'tenant'>;
export type ConnectionType = 'service' | 'user' | 'application'; // 'service' is for internal services, 'user' is for users, 'application' is for external applications

export type PaymentMethod = 'transfer' | 'credit-card' | 'cash' | 'check';
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
  | 'custom_percentage';

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

export type ContractorSpecialty =
  | 'plumber'
  | 'electrician'
  | 'elevator'
  | 'painter'
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
  | 'scheduled'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

export type RepairUrgency = 'emergency' | 'normal' | 'low';
