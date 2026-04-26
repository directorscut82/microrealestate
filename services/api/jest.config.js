export default {
  collectCoverage: true,
  collectCoverageFrom: ['./src/**/*.{js,ts}'],
  coverageDirectory: 'coverage',
  coverageProvider: 'v8',
  extensionsToTreatAsEsm: ['.ts'],
  testMatch: ['**/src/**/__tests__/**/*.test.js'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  transform: {
    '^.+\\.(js|ts)$': [
      '@swc/jest',
      {
        jsc: { parser: { syntax: 'typescript' } },
        module: { type: 'es6' }
      }
    ]
  }
};
