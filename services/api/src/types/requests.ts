import type { ServiceRequest, ServiceResponse } from '@microrealestate/types';

// Common route parameter shapes
export interface IdParams { id: string }
export interface IdsParams { ids: string }
export interface IdTermParams { id: string; term: string }
export interface YearMonthParams { year: string; month: string }
export interface TypeIdParams { type: string; id: string }
export interface BuildingSubParams { id: string; unitId?: string; expenseId?: string; contractorId?: string; repairId?: string; chargeId?: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBody = any;

// Typed request aliases — params are typed, body remains any until schemas are defined
export type ReqWithId = ServiceRequest<IdParams, unknown, AnyBody>;
export type ReqWithIds = ServiceRequest<IdsParams, unknown, AnyBody>;
export type ReqWithIdTerm = ServiceRequest<IdTermParams, unknown, AnyBody>;
export type ReqWithYearMonth = ServiceRequest<YearMonthParams, unknown, AnyBody>;
export type ReqNoParams = ServiceRequest<Record<string, string>, unknown, AnyBody>;
export type Res = ServiceResponse;
