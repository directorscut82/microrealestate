// CJS manual mock. api package is `type: module`, so a `.js` mock is treated
// as ESM and CANNOT be require()'d by the real (CommonJS) express-winston —
// that threw ERR_REQUIRE_ESM and took down every suite that imports
// @microrealestate/common. `.cjs` is unconditionally CommonJS, so it is
// requireable by both CJS and the swc-transformed (CJS) test modules.
const noop = () => ({});
const format = { combine: noop, timestamp: noop, printf: noop, simple: noop, colorize: noop, errors: noop, json: noop, label: noop, splat: noop, metadata: noop };
const mkLogger = () => ({ info() {}, warn() {}, error() {}, debug() {}, silly() {}, verbose() {}, add() {}, child() { return mkLogger(); } });
module.exports = {
  format,
  transports: { Console: function () {}, File: function () {} },
  addColors() {}, add() {}, remove() {},
  info() {}, warn() {}, error() {}, debug() {}, silly() {}, verbose() {},
  createLogger: mkLogger
};
module.exports.default = module.exports;
