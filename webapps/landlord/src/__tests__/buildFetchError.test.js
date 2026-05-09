import { buildFetchError } from '../utils/fetch';

describe('buildFetchError', () => {
  it('should strip Authorization header from error object', () => {
    const error = {
      response: {
        status: 500,
        statusText: 'Internal Server Error',
        headers: { 'content-type': 'application/json' },
        config: {
          url: '/tenants',
          method: 'get',
          baseURL: 'http://localhost:8080/api/v2',
          withCredentials: false,
          headers: {
            Authorization: 'Bearer secret-access-token-12345',
            organizationId: 'org-123',
            'Accept-Language': 'fr-FR'
          }
        }
      }
    };

    const result = buildFetchError(error);

    expect(result.error.request.headers).not.toHaveProperty('Authorization');
    expect(result.error.request.headers).not.toHaveProperty('authorization');
    expect(result.error.request.headers).toHaveProperty('organizationId', 'org-123');
    expect(result.error.request.headers).toHaveProperty('Accept-Language', 'fr-FR');
  });

  it('should strip lowercase authorization header', () => {
    const error = {
      response: {
        status: 401,
        statusText: 'Unauthorized',
        headers: {},
        config: {
          url: '/rents/2026',
          method: 'get',
          baseURL: 'http://localhost:8080/api/v2',
          withCredentials: true,
          headers: {
            authorization: 'Bearer leaked-token',
            'content-type': 'application/json'
          }
        }
      }
    };

    const result = buildFetchError(error);

    expect(result.error.request.headers).not.toHaveProperty('authorization');
    expect(result.error.request.headers).not.toHaveProperty('Authorization');
    expect(result.error.request.headers).toHaveProperty('content-type', 'application/json');
  });

  it('should preserve status and url metadata', () => {
    const error = {
      response: {
        status: 404,
        statusText: 'Not Found',
        headers: { 'x-request-id': 'abc123' },
        config: {
          url: '/tenants/invalid-id',
          method: 'get',
          baseURL: 'http://localhost:8080/api/v2',
          withCredentials: false,
          headers: { Authorization: 'Bearer token' }
        }
      }
    };

    const result = buildFetchError(error);

    expect(result.error.status).toBe(404);
    expect(result.error.statusText).toBe('Not Found');
    expect(result.error.request.url).toBe('/tenants/invalid-id');
    expect(result.error.request.method).toBe('get');
  });

  it('should handle missing response gracefully', () => {
    const error = { response: undefined };
    const result = buildFetchError(error);

    expect(result.error.status).toBeUndefined();
    expect(result.error.request.headers).toEqual({});
  });
});
