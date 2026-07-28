import * as Express from 'express';
import {
  EnvironmentConfig,
  logger,
  Middlewares,
  Service,
  ServiceError,
  URLUtils
} from '@microrealestate/common';
import axios from 'axios';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';

Main();

async function onStartUp(application: Express.Application) {
  // The gateway IS the edge proxy — there is no upstream proxy in front of
  // it that we trust to set X-Forwarded-For correctly. Disabling
  // trust-proxy makes Express ignore client-supplied X-F-F headers and
  // exposes the real connecting peer through req.socket.remoteAddress.
  // Combined with the rate limiter keying on req.socket.remoteAddress (not
  // req.ip), this kills the X-F-F-spoofed-rate-limit-bypass path.
  application.set('trust proxy', false);
  exposeHealthCheck(application);
  exposeFrontends(application);
  configureCORS(application);
  exposeServices(application);
}

async function Main() {
  let service;
  try {
    service = Service.getInstance(
      new EnvironmentConfig({
        PORT: Number(process.env.PORT) || 8080,
        EXPOSE_FRONTENDS: process.env.EXPOSE_FRONTENDS === 'true',
        AUTHENTICATOR_URL: process.env.AUTHENTICATOR_URL,
        API_URL: process.env.API_URL,
        PDFGENERATOR_URL: process.env.PDFGENERATOR_URL,
        EMAILER_URL: process.env.EMAILER_URL,
        RESETSERVICE_URL: process.env.RESETSERVICE_URL,
        LANDLORD_FRONTEND_URL: process.env.LANDLORD_FRONTEND_URL,
        LANDLORD_BASE_PATH: process.env.LANDLORD_BASE_PATH,
        TENANT_FRONTEND_URL: process.env.TENANT_FRONTEND_URL,
        TENANT_BASE_PATH: process.env.TENANT_BASE_PATH,
        DOMAIN_URL: process.env.DOMAIN_URL || 'http://localhost', // deprecated
        APP_DOMAIN: process.env.APP_DOMAIN,
        CORS_ENABLED: process.env.CORS_ENABLED === 'true',
        TENANTAPI_URL: process.env.TENANTAPI_URL
      })
    );
    await service.init({
      name: 'Gateway',
      useRequestParsers: false,
      exposeHealthCheck: false,
      onStartUp
    });
    await service.startUp();
  } catch (error) {
    logger.error(String(error));
    service?.shutDown(-1);
  }
}

function configureCORS(application: Express.Application) {
  const config = Service.getInstance().envConfig.getValues();
  if (config.CORS_ENABLED && (config.DOMAIN_URL || config.APP_DOMAIN)) {
    // Build the list of allowed origin domains (with optional port).
    // APP_DOMAIN may be a comma-separated list (multi-origin NAS deployments,
    // e.g. "localhost:8080,192.168.0.96:1350,100.121.85.7:1350").
    const rawDomains: string[] = [];
    if (config.APP_DOMAIN) {
      rawDomains.push(
        ...String(config.APP_DOMAIN)
          .split(',')
          .map((d) => d.trim())
          .filter(Boolean)
      );
    }
    if (config.DOMAIN_URL) {
      // E4: URLUtils.destructUrl strips the leading subdomain when the
      // hostname has 3+ labels (e.g. 'app.example.com' -> 'example.com'),
      // which means an Origin header for the actual deployed subdomain
      // never matched the resulting CORS regex. Use the URL constructor's
      // .host directly so the registered origin matches the browser's
      // Origin byte-for-byte.
      try {
        const parsed = new URL(config.DOMAIN_URL);
        if (parsed.host) {
          rawDomains.push(parsed.host);
        }
      } catch {
        // Malformed DOMAIN_URL — fall back to the legacy helper rather
        // than silently dropping the value.
        rawDomains.push(URLUtils.destructUrl(config.DOMAIN_URL).domain);
      }
    }

    // Escape regex meta-chars in each domain literal (dots, ports, etc.) and
    // require an exact match (no leading subdomain capture). Without this,
    // an origin like `attacker.com.example.com` would slip past
    // `^https?://(.*\.)?example.com$`.
    const escapedDomains = rawDomains.map((d) =>
      d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    );

    const allowedOriginRegexes = escapedDomains.map(
      (d) => new RegExp(`^https?://${d}$`)
    );

    logger.info(
      `CORS allowed origins: ${rawDomains.map((d) => `http(s)://${d}`).join(', ')}`
    );

    const corsOptions = {
      origin: (
        origin: string | undefined,
        callback: (err: Error | null, allow?: boolean) => void
      ) => {
        // Allow same-origin / non-browser callers (no Origin header)
        if (!origin) return callback(null, true);
        const allowed = allowedOriginRegexes.some((re) => re.test(origin));
        if (!allowed) logger.warn(`CORS blocked origin: ${origin}`);
        return callback(null, allowed);
      },
      methods: 'GET,POST,PUT,PATCH,DELETE',
      allowedHeaders:
        //',If-Modified-Since,Range, DNT',
        'Origin,User-Agent,X-Requested-With,Cache-Control,Content-Type,Accept,Authorization,organizationId,timeout',
      credentials: true
    };

    application.use('/api', cors(corsOptions));
    application.use('/tenantapi', cors(corsOptions));
  }
}

function exposeFrontends(application: Express.Application) {
  const config = Service.getInstance().envConfig.getValues();
  if (config.EXPOSE_FRONTENDS) {
    if (!config.LANDLORD_BASE_PATH) {
      throw new Error('LANDLORD_BASE_PATH is not defined');
    }
    application.use(
      config.LANDLORD_BASE_PATH,
      createProxyMiddleware({
        target: config.LANDLORD_FRONTEND_URL,
        ws: true
      })
    );

    if (!config.TENANT_BASE_PATH) {
      throw new Error('TENANT_BASE_PATH is not defined');
    }
    application.use(
      config.TENANT_BASE_PATH,
      createProxyMiddleware({
        target: config.TENANT_FRONTEND_URL,
        ws: true
      })
    );
  }
}

// Shared error handler for the service proxies. Without an onError, an
// unreachable/timed-out upstream leaves the client socket hanging until the
// browser gives up (no response is ever written) — the gateway looks "down"
// (ingress+error-path audit 2026-07). Emit a clean 502/504 instead.
function proxyErrorHandler(
  err: NodeJS.ErrnoException,
  _req: Express.Request,
  res: Express.Response
) {
  const timedOut = err?.code === 'ECONNRESET' || err?.code === 'ETIMEDOUT';
  logger.error(`gateway proxy error: ${err?.code || ''} ${err?.message || err}`);
  // res may be a plain socket (ws upgrade) with no writeHead — guard it.
  if (res && typeof (res as any).writeHead === 'function' && !res.headersSent) {
    res.writeHead(timedOut ? 504 : 502, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: timedOut ? 'upstream timeout' : 'bad gateway' })
    );
  } else if (res && typeof (res as any).end === 'function') {
    (res as any).end();
  }
}

// proxyTimeout bounds the gateway→upstream leg; timeout bounds the
// client→gateway incoming socket.
//
// STANDARD (60s) — for quick money/CRUD/auth endpoints. None legitimately take
// this long, so 60s is a fast-fail backstop against a wedged upstream (hung
// mongo query).
//
// HEAVY (300s) — for the synchronous OCR / PDF-render routes. These emit NO
// intermediate bytes before completing, so http-proxy's idle timer equals
// wall-clock; a tight 60s would 504 the app's OWN bill-parse (up to 20 images,
// OCR serialized) and PDF generation (per-render cap 120s) MID-OPERATION and
// orphan the work (Step-7). The upstream services already bound each unit of
// work at the source (OCR 120s/page in billparser/ocr.ts, page.goto/page.pdf
// 120s in chromeheadless.ts), so an infinite hang is prevented there; this
// larger value is only a coarse backstop covering a realistic multi-image
// batch. (A pathological 20-image upload on a 1-thread container could still
// exceed 300s and 504 — an accepted extreme edge, far rarer than severing every
// 2-image parse at 60s.)
const PROXY_TIMEOUTS = { proxyTimeout: 60_000, timeout: 65_000 };
const HEAVY_PROXY_TIMEOUTS = { proxyTimeout: 300_000, timeout: 305_000 };

function exposeServices(application: Express.Application) {
  const config = Service.getInstance().envConfig.getValues();
  application.use(
    '/api/v2/authenticator',
    createProxyMiddleware({
      target: config.AUTHENTICATOR_URL,
      pathRewrite: { '^/api/v2/authenticator': '' },
      ...PROXY_TIMEOUTS,
      onError: proxyErrorHandler
    })
  );

  // PDF generation renders synchronously before streaming — HEAVY budget.
  application.use(
    '/api/v2/documents',
    createProxyMiddleware({
      target: config.PDFGENERATOR_URL,
      pathRewrite: { '^/api/v2': '' },
      ...HEAVY_PROXY_TIMEOUTS,
      onError: proxyErrorHandler
    })
  );

  application.use(
    '/api/v2/templates',
    createProxyMiddleware({
      target: config.PDFGENERATOR_URL,
      pathRewrite: { '^/api/v2': '' },
      ...HEAVY_PROXY_TIMEOUTS,
      onError: proxyErrorHandler
    })
  );

  // Slow synchronous api routes — HEAVY budget. Mounted BEFORE the /api/v2
  // catch-all so the more-specific path wins (Express first-match); everything
  // else on /api/v2 keeps the tight STANDARD backstop.
  //   - /bills/*: the whole namespace. /bills/parse + /bills/payment-receipt run
  //     seconds of serialized OCR; /bills/:id/attach-source does a B2 upload
  //     (Step-7 round-2 LOW). The quick CRUD bill routes complete in <1s, so the
  //     larger backstop never bites them — it only prevents a 60s cap from
  //     severing the genuinely slow ones. Covering the namespace also avoids a
  //     fragile `:id`-in-the-middle mount for attach-source.
  //   - /emails/*: the api renders a PDF then waits on the emailer's own send
  //     (PDF fetch 30s + SMTP up to 70s ≈ 100s; api EMAILER_TIMEOUT is 120s).
  //     A tight 60s gateway cap here would 504 the browser↔api leg mid-send and
  //     the landlord's retry would DOUBLE-send (Step-7 round-2). The gateway
  //     budget must be the OUTERMOST, so it exceeds the api's downstream wait.
  for (const heavyPath of ['/api/v2/bills', '/api/v2/emails']) {
    application.use(
      heavyPath,
      createProxyMiddleware({
        target: config.API_URL,
        pathRewrite: { '^/api/v2': '' },
        ...HEAVY_PROXY_TIMEOUTS,
        onError: proxyErrorHandler
      })
    );
  }

  application.use(
    '/api/v2',
    createProxyMiddleware({
      target: config.API_URL,
      pathRewrite: { '^/api/v2': '' },
      ...PROXY_TIMEOUTS,
      onError: proxyErrorHandler
    })
  );

  application.use(
    '/tenantapi',
    createProxyMiddleware({
      target: config.TENANTAPI_URL,
      pathRewrite: { '^/tenantapi': '' },
      ...PROXY_TIMEOUTS,
      onError: proxyErrorHandler
    })
  );

  // Do not expose reset api on Prod
  if (!config.PRODUCTION && config.RESETSERVICE_URL) {
    application.use(
      '/api/reset',
      createProxyMiddleware({
        target: config.RESETSERVICE_URL,
        pathRewrite: { '^/api': '' }
      })
    );
  }
}

function exposeHealthCheck(application: Express.Application) {
  application.get(
    '/health',
    Middlewares.asyncWrapper(async (req, res) => {
      const config = Service.getInstance().envConfig.getValues();

      const serviceEndpoints = [
        config.AUTHENTICATOR_URL,
        config.API_URL,
        config.TENANTAPI_URL,
        config.PDFGENERATOR_URL,
        config.EMAILER_URL
      ];

      if (!config.PRODUCTION && config.RESETSERVICE_URL) {
        serviceEndpoints.push(config.RESETSERVICE_URL);
      }

      const notDefinedEnpoints = serviceEndpoints.filter(
        (endpoint) => !endpoint
      );
      if (notDefinedEnpoints.length) {
        throw new ServiceError(
          `${notDefinedEnpoints.join(', ')} env ${
            notDefinedEnpoints.length > 1 ? 'are' : 'is'
          } not defined`,
          500
        );
      }

      const endpoints = serviceEndpoints.map((endpoint) => {
        const url = new URL(endpoint as string);
        return `${url.origin}/health`;
      });

      // Note: deliberately NOT probing the landlord / tenant Next.js
      // frontends. They do not expose a /health endpoint, so the previous
      // probe always 404'd which the aggregator treated as 500. Backend
      // service health (each /health below) is what matters for routing.

      const results = await Promise.all(
        endpoints.map(async (endpoint) => {
          try {
            const response = await axios.get(endpoint, { timeout: 5000 });
            return { status: response.status };
          } catch (error) {
            return { status: 500, error };
          }
        })
      );
      results.forEach((result, index) => {
        if (result.status !== 200) {
          logger.error(
            `${result.status} GET ${endpoints[index]}\n\t${result.error}`
          );
        } else {
          logger.info(`${result.status} GET ${endpoints[index]}`);
        }
      });
      if (results.some((result) => result.status !== 200)) {
        throw new ServiceError('Some services are down', 500);
      }

      res.status(200).send('OK');
    })
  );
}
