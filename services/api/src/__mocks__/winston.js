const format = {
  combine: jest.fn(() => ({})),
  timestamp: jest.fn(() => ({})),
  printf: jest.fn(() => ({})),
  simple: jest.fn(() => ({})),
  colorize: jest.fn(() => ({})),
  errors: jest.fn(() => ({}))
};

export const transports = {
  Console: jest.fn(),
  File: jest.fn()
};

export const add = jest.fn();
export const remove = jest.fn();
export const info = jest.fn();
export const warn = jest.fn();
export const error = jest.fn();
export const debug = jest.fn();
export const silly = jest.fn();
export { format };

export const createLogger = jest.fn(() => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  silly: jest.fn(),
  add: jest.fn()
}));

export default {
  transports,
  format,
  add,
  remove,
  info,
  warn,
  error,
  debug,
  silly,
  createLogger
};
