export default {
  collectCoverage: true,
  collectCoverageFrom: ['./src/**/*.{js,ts}'],
  coverageDirectory: 'coverage',
  coverageProvider: 'v8',
  extensionsToTreatAsEsm: ['.ts'],
  testMatch: ['**/src/**/__tests__/**/*.test.js'],
  moduleFileExtensions: ['ts', 'js', 'cjs', 'json'],
  moduleNameMapper: {
    // winston / express-winston / jsonwebtoken are mocked. This package is
    // `type: module`, so a `.js` manual mock is loaded as ESM — and the REAL
    // express-winston is CommonJS and `require()`s winston, which threw
    // ERR_REQUIRE_ESM the moment any suite imported @microrealestate/common
    // (i.e. nearly all of them). The fix: author the mocks as `.cjs` (always
    // CommonJS regardless of package `type`) and redirect the bare specifiers
    // here so the real CJS packages never load. A stale Jest transform cache
    // masked this for a while; `--clearCache` surfaced it.
    '^winston$': '<rootDir>/src/__mocks__/winston.cjs',
    '^express-winston$': '<rootDir>/src/__mocks__/express-winston.cjs',
    '^jsonwebtoken$': '<rootDir>/src/__mocks__/jsonwebtoken.cjs',
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  transform: {
    '^.+\\.(js|ts|cjs)$': [
      '@swc/jest',
      {
        jsc: { parser: { syntax: 'typescript' } },
        module: { type: 'es6' }
      }
    ]
  }
};
