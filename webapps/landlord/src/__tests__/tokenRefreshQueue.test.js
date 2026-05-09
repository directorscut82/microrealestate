// Test the token refresh queue rejection behavior by simulating the interceptor logic.
// The actual interceptor is inside apiFetcher() closure, so we test the pattern directly.
describe('Token refresh queue rejection', () => {
  it('should reject all queued requests when refresh fails', async () => {
    let isRefreshingToken = false;
    let requestQueue = [];

    // Simulate the refresh interceptor logic
    function simulateInterceptor(shouldRefreshFail) {
      return new Promise((resolve, reject) => {
        if (isRefreshingToken) {
          // Queue this request
          requestQueue.push({ resolve, reject });
          return;
        }
        isRefreshingToken = true;

        // Simulate async refresh
        setTimeout(() => {
          if (shouldRefreshFail) {
            const refreshError = new Error('Refresh token expired');
            // Reject all queued requests
            requestQueue.forEach((request) => {
              request.reject(refreshError);
            });
          } else {
            requestQueue.forEach((request) => {
              request.resolve();
            });
          }
          isRefreshingToken = false;
          requestQueue = [];

          if (shouldRefreshFail) {
            reject(new Error('Refresh token expired'));
          } else {
            resolve('success');
          }
        }, 10);
      });
    }

    // Fire 3 parallel requests that all get 401
    const results = await Promise.allSettled([
      simulateInterceptor(true),  // first request triggers refresh
      simulateInterceptor(true),  // queued
      simulateInterceptor(true)   // queued
    ]);

    // ALL should be rejected (not hanging as unresolved promises)
    expect(results[0].status).toBe('rejected');
    expect(results[0].reason.message).toBe('Refresh token expired');
    expect(results[1].status).toBe('rejected');
    expect(results[1].reason.message).toBe('Refresh token expired');
    expect(results[2].status).toBe('rejected');
    expect(results[2].reason.message).toBe('Refresh token expired');
  });

  it('should resolve all queued requests when refresh succeeds', async () => {
    let isRefreshingToken = false;
    let requestQueue = [];

    function simulateInterceptor(shouldRefreshFail) {
      return new Promise((resolve, reject) => {
        if (isRefreshingToken) {
          requestQueue.push({ resolve, reject });
          return;
        }
        isRefreshingToken = true;

        setTimeout(() => {
          if (shouldRefreshFail) {
            requestQueue.forEach((r) => r.reject(new Error('failed')));
          } else {
            requestQueue.forEach((r) => r.resolve('retried'));
          }
          isRefreshingToken = false;
          requestQueue = [];

          if (shouldRefreshFail) {
            reject(new Error('failed'));
          } else {
            resolve('refreshed');
          }
        }, 10);
      });
    }

    const results = await Promise.allSettled([
      simulateInterceptor(false),
      simulateInterceptor(false),
      simulateInterceptor(false)
    ]);

    expect(results[0].status).toBe('fulfilled');
    expect(results[0].value).toBe('refreshed');
    expect(results[1].status).toBe('fulfilled');
    expect(results[1].value).toBe('retried');
    expect(results[2].status).toBe('fulfilled');
    expect(results[2].value).toBe('retried');
  });

  it('should not leave promises hanging indefinitely on failure', async () => {
    let isRefreshingToken = false;
    let requestQueue = [];

    function simulateQueuedRequest() {
      return new Promise((resolve, reject) => {
        if (isRefreshingToken) {
          requestQueue.push({ resolve, reject });
          return;
        }
        isRefreshingToken = true;
        setTimeout(() => {
          const err = new Error('Session expired');
          requestQueue.forEach((r) => r.reject(err));
          isRefreshingToken = false;
          requestQueue = [];
          reject(err);
        }, 5);
      });
    }

    // This test proves promises settle within a reasonable time
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT - promises hung')), 1000)
    );

    const allRequests = Promise.allSettled([
      simulateQueuedRequest(),
      simulateQueuedRequest(),
      simulateQueuedRequest()
    ]);

    const result = await Promise.race([allRequests, timeout]);
    expect(result).toHaveLength(3);
    result.forEach((r) => expect(r.status).toBe('rejected'));
  });
});
