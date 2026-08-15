import * as axios from 'axios';
import logger from './logger.js';

/**
 * Redact secrets that live in a URL PATH rather than a header.
 *
 * The Telegram Bot API puts the bot token in the path — `/bot<token>/getUpdates` — and this
 * interceptor logged every outbound URL verbatim. The inbox poller calls getUpdates once a
 * minute per realm, so the live token was written to the container log ~1440 times a day,
 * indefinitely, in plaintext. Anyone who can read logs (Portainer, a support bundle, a
 * shipped log aggregator) had the credential, and rotating it is the only remedy once seen —
 * the same class as the sms-gate.app exposure recorded in PII_INCIDENT_2026_07_31.
 *
 * Header-borne secrets were already safe: `Authorization` is logged only at debug level and
 * this file's header dump is separate. It is specifically the path-embedded ones that leaked.
 */
function _redactUrl(url: string): string {
  return (
    url
      // Telegram: /bot<digits>:<secret>/method
      .replace(/\/bot\d+:[A-Za-z0-9_-]+/g, '/bot<redacted>')
      // Generic: a token/key/secret/password carried as a query parameter.
      .replace(
        /([?&](?:token|access_token|key|api_key|apikey|secret|password)=)[^&]+/gi,
        '$1<redacted>'
      )
  );
}

export default function httpInterceptors() {
  // For logging purposes
  axios.default.interceptors.request.use(
    (config) => {
      if (config?.method && config?.url) {
        logger.info(
          `${config.method.toUpperCase()} ${_redactUrl(config.url)}`
        );
      }

      // log config headers
      if (config?.headers) {
        logger.debug('Headers:');
        Object.entries(config.headers)
          .sort(([key1], [key2]) => key1.localeCompare(key2))
          .reduce(
            (acc, [key, value]) => [...acc, `${key}: ${JSON.stringify(value)}`],
            [] as string[]
          )
          .forEach((configLine) => logger.debug(configLine));
      }
      return config;
    },
    (error) => {
      logger.error(error?.message || error);
      return Promise.reject(error);
    }
  );

  axios.default.interceptors.response.use(
    (response) => {
      if (
        response?.config?.method &&
        response?.config?.url &&
        response?.status
      ) {
        logger.info(
          `${response.config.method.toUpperCase()} ${_redactUrl(response.config.url)} ${
            response.status
          }`
        );
      }
      return response;
    },
    (error) => {
      if (
        error?.config?.method &&
        error?.response?.url &&
        error?.response?.status
      ) {
        logger.error(
          `${error.config.method.toUpperCase()} ${_redactUrl(error.config.url)} ${
            error.response.status
          }`
        );
      } else {
        logger.error(error?.message || error);
      }
      return Promise.reject(error);
    }
  );
}
