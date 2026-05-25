import { EnvironmentConfig, logger, Service } from '@microrealestate/common';
import Express from 'express';
import routes from './routes/index.js';

Main();

async function onStartUp(express: Express.Application): Promise<void> {
  // Trust the proxy (gateway) so req.ip reflects the real client via
  // X-Forwarded-For — required for the per-IP rate limiter to be meaningful.
  express.set('trust proxy', 1);

  // Validate critical secrets at startup (fail fast instead of runtime errors)
  const config = Service.getInstance().envConfig.getValues();
  const requiredSecrets = [
    'ACCESS_TOKEN_SECRET',
    'REFRESH_TOKEN_SECRET',
    'RESET_TOKEN_SECRET',
    'APPCREDZ_TOKEN_SECRET'
  ] as const;
  for (const key of requiredSecrets) {
    const value = config[key];
    if (!value || String(value).length < 16) {
      throw new Error(
        `${key} is missing or too short (min 16 chars). Set it in your environment.`
      );
    }
  }

  if (
    process.env.NODE_ENV === 'production' &&
    process.env.APP_PROTOCOL !== 'https'
  ) {
    logger.warn(
      'NODE_ENV=production but APP_PROTOCOL is not https — auth cookies will not be flagged Secure'
    );
  }

  express.use(routes());
}

async function Main(): Promise<void> {
  let service: Service | undefined;
  try {
    let tokenCookieSecure = process.env.APP_PROTOCOL === 'https';

    // to be removed in next version of the app (deprecated)
    if (process.env.DOMAIN_URL) {
      const DOMAIN_URL = new URL(
        process.env.DOMAIN_URL || 'http://localhost:8083'
      );
      tokenCookieSecure = DOMAIN_URL.protocol === 'https:';
    }

    // Do NOT set the cookie `domain` attribute. APP_DOMAIN may be a
    // comma-separated list of hosts (multi-origin NAS), and even a single
    // value tied to a specific host breaks browsers when the user reaches
    // the app via a different alias. Leaving `domain` undefined produces
    // host-only cookies, which work for every origin the gateway serves.
    service = Service.getInstance(
      new EnvironmentConfig({
        PORT: Number(process.env.PORT || 8083),
        EMAILER_URL: process.env.EMAILER_URL || 'http://localhost:8083/emailer',
        SIGNUP: process.env.SIGNUP === 'true',
        TOKEN_COOKIE_ATTRIBUTES: {
          httpOnly: true,
          sameSite: 'strict',
          secure: tokenCookieSecure
          // No explicit `domain` attribute: cookies become host-only, bound to
          // whatever hostname the browser used to reach the app. This lets the
          // same app serve multiple origins (LAN IP + Tailscale IP + domain
          // name) with each origin getting its own session cookie.
        }
      })
    );

    await service.init({
      name: 'Authenticator',
      useMongo: true,
      useRedis: true,
      onStartUp
    });

    await service.startUp();
  } catch (error) {
    logger.error(String(error));
    service?.shutDown(-1);
  }
}
