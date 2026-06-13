// CJS manual mock — see winston.cjs for why .cjs (not .js). expressWinston
// .logger()/.errorLogger() are called with a config object and must return
// an express middleware (req,res,next)=>next().
function logger() { return (req, res, next) => next(); }
function errorLogger() { return (req, res, next) => next(); }
module.exports = { logger, errorLogger };
module.exports.default = module.exports;
