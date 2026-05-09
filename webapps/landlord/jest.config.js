module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/src/__tests__/**/*.test.{js,jsx}'],
  moduleFileExtensions: ['js', 'jsx', 'json'],
  moduleNameMapper: {
    '^@microrealestate/commonui/(.*)$': '<rootDir>/src/__mocks__/commonui.js',
    '^../config$': '<rootDir>/src/__mocks__/config.js',
    '^../store$': '<rootDir>/src/__mocks__/store.js',
    '^../../store$': '<rootDir>/src/__mocks__/store.js',
    '^canvas$': '<rootDir>/src/__mocks__/empty.js'
  },
  transform: {
    '^.+\\.(js|jsx)$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'ecmascript', jsx: true },
          transform: { react: { runtime: 'automatic' } }
        }
      }
    ]
  },
  transformIgnorePatterns: [
    'node_modules/(?!(@microrealestate|axios|js-file-download)/)'
  ]
};
