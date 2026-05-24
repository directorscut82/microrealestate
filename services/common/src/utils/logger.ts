import winston from 'winston';

export const transports = [
  new winston.transports.Console({
    level: process.env.LOGGER_LEVEL || 'debug',
    format: winston.format.combine(
      winston.format.timestamp({
        format: 'YYYY-MM-DDTHH:mm:ss.sss'
      }),
      winston.format.errors({ stack: true }),
      winston.format.printf((info) => {
        const ts = info.timestamp || new Date().toISOString();
        const lvl = (info.level || 'info').toString();
        // When format.errors() is given an Error object, it moves the message
        // onto info.stack and may leave info.message undefined. Fall back
        // through stack -> JSON so we never log "<E> undefined".
        const msg =
          info.message !== undefined && info.message !== null
            ? info.message
            : info.stack || JSON.stringify(info);
        return `${ts} <${lvl.toUpperCase()[0]}> ${msg}`;
      })
    )
  })
];

const logger = winston.createLogger({
  transports
});

export default logger;
