/* eslint-env node */
import {
  parsePagination,
  buildPaginationMeta,
  setPaginationHeaders
} from '@microrealestate/common/dist/utils/pagination.js';

describe('Pagination utility', () => {
  describe('parsePagination', () => {
    function makeReq(query = {}) {
      return { query };
    }

    it('should return defaults when no params provided', () => {
      const result = parsePagination(makeReq());
      expect(result).toEqual({ page: 1, limit: 0, skip: 0, isPaginated: false });
    });

    it('should parse valid page and limit', () => {
      const result = parsePagination(makeReq({ page: '3', limit: '25' }));
      expect(result).toEqual({ page: 3, limit: 25, skip: 50, isPaginated: true });
    });

    it('should calculate skip correctly for page 1', () => {
      const result = parsePagination(makeReq({ page: '1', limit: '10' }));
      expect(result.skip).toBe(0);
    });

    it('should calculate skip correctly for page 5 with limit 20', () => {
      const result = parsePagination(makeReq({ page: '5', limit: '20' }));
      expect(result.skip).toBe(80);
    });

    it('should clamp limit to max 500', () => {
      const result = parsePagination(makeReq({ limit: '9999' }));
      expect(result.limit).toBe(500);
    });

    it('should clamp limit to min 1', () => {
      const result = parsePagination(makeReq({ limit: '0' }));
      expect(result.limit).toBe(1);
    });

    it('should clamp negative limit to 1', () => {
      const result = parsePagination(makeReq({ limit: '-5' }));
      expect(result.limit).toBe(1);
    });

    it('should default page to 1 when invalid', () => {
      const result = parsePagination(makeReq({ page: 'abc' }));
      expect(result.page).toBe(1);
    });

    it('should default page to 1 when zero', () => {
      const result = parsePagination(makeReq({ page: '0' }));
      expect(result.page).toBe(1);
    });

    it('should default page to 1 when negative', () => {
      const result = parsePagination(makeReq({ page: '-2' }));
      expect(result.page).toBe(1);
    });

    it('should floor fractional page numbers', () => {
      const result = parsePagination(makeReq({ page: '2.7' }));
      expect(result.page).toBe(2);
    });

    it('should floor fractional limits', () => {
      const result = parsePagination(makeReq({ limit: '15.9' }));
      expect(result.limit).toBe(15);
    });

    it('should handle NaN limit gracefully', () => {
      const result = parsePagination(makeReq({ limit: 'xyz' }));
      expect(result.limit).toBe(100);
    });

    it('should handle Infinity page gracefully', () => {
      const result = parsePagination(makeReq({ page: 'Infinity' }));
      expect(result.page).toBe(1);
    });
  });

  describe('buildPaginationMeta', () => {
    it('should compute totalPages correctly', () => {
      const meta = buildPaginationMeta(95, 1, 10);
      expect(meta).toEqual({
        total: 95,
        page: 1,
        limit: 10,
        totalPages: 10
      });
    });

    it('should handle exact division', () => {
      const meta = buildPaginationMeta(100, 2, 50);
      expect(meta.totalPages).toBe(2);
    });

    it('should handle zero total', () => {
      const meta = buildPaginationMeta(0, 1, 50);
      expect(meta.totalPages).toBe(0);
    });

    it('should handle single item', () => {
      const meta = buildPaginationMeta(1, 1, 50);
      expect(meta.totalPages).toBe(1);
    });
  });

  describe('setPaginationHeaders', () => {
    it('should set all pagination headers', () => {
      const headers = {};
      const res = {
        set(key, value) {
          headers[key] = value;
        }
      };
      setPaginationHeaders(res, {
        total: 200,
        page: 3,
        limit: 25,
        totalPages: 8
      });
      expect(headers).toEqual({
        'Access-Control-Expose-Headers': 'X-Total-Count,X-Page,X-Limit,X-Total-Pages',
        'X-Total-Count': '200',
        'X-Page': '3',
        'X-Limit': '25',
        'X-Total-Pages': '8'
      });
    });
  });
});
