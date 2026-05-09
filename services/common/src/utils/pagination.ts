import type { Request, Response } from 'express';

export interface PaginationParams {
  page: number;
  limit: number;
  skip: number;
  isPaginated: boolean;
}

export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MIN_LIMIT = 1;

export function parsePagination(req: Request): PaginationParams {
  const hasPage = req.query.page !== undefined;
  const hasLimit = req.query.limit !== undefined;
  const isPaginated = hasPage || hasLimit;

  if (!isPaginated) {
    return { page: 1, limit: 0, skip: 0, isPaginated: false };
  }

  const rawPage = Number(req.query.page);
  const rawLimit = Number(req.query.limit);

  const page = Number.isFinite(rawPage) && rawPage >= 1
    ? Math.floor(rawPage)
    : 1;

  const limit = Number.isFinite(rawLimit)
    ? Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Math.floor(rawLimit)))
    : DEFAULT_LIMIT;

  const skip = (page - 1) * limit;

  return { page, limit, skip, isPaginated: true };
}

export function setPaginationHeaders(
  res: Response,
  meta: PaginationMeta
): void {
  const paginationHeaders = 'X-Total-Count,X-Page,X-Limit,X-Total-Pages';
  res.set('X-Total-Count', String(meta.total));
  res.set('X-Page', String(meta.page));
  res.set('X-Limit', String(meta.limit));
  res.set('X-Total-Pages', String(meta.totalPages));
  // Must be set here (not gateway) because http-proxy-middleware
  // overwrites headers set by earlier middleware
  res.set('Access-Control-Expose-Headers', paginationHeaders);
}

export function buildPaginationMeta(
  total: number,
  page: number,
  limit: number
): PaginationMeta {
  return {
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit)
  };
}
