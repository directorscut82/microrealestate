export function getStoreInstance() {
  return {
    user: { refreshTokens: jest.fn() }
  };
}
