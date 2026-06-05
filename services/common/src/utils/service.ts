import * as Logger from './logger.js';
import {
  ConnectionRole,
  InternalServicePrincipal,
  ServiceOptions
} from '@microrealestate/types';
import _cookieParser from 'cookie-parser';
import _methodOverride from 'method-override';
import EnvironmentConfig from './environmentconfig.js';
import Express from 'express';
import expressWinston from 'express-winston';
import httpInterceptors from './httpinterceptors.js';
import jwt from 'jsonwebtoken';
import { Middlewares } from '../index.js';
import MongoClient from './mongoclient.js';
import mongoSanitize from 'express-mongo-sanitize';
import RedisClient from './redisclient.js';
import winston from 'winston';

// Docker sends SIGTERM on `docker stop` / Portainer stack recreation. Without
// a SIGTERM handler the process gets the default action (terminate) and
// containers exit abruptly after the 10s grace period via SIGKILL — leaving
// redis/mongo with un-flushed client connections and surfacing as
// "stopped unexpectedly" alerts in container managers. SIGINT is what we get
// from Ctrl-C in dev. Both should drain the same way.
const _gracefulShutdown = async (signal: string) => {
  try {
    Logger.default.info(`received ${signal}, shutting down`);
    await Service.getInstance()?.shutDown(0);
  } catch (error) {
    Logger.default.error(String(error));
  }
};
process.on('SIGINT', () => _gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => _gracefulShutdown('SIGTERM'));

export default class Service {
  static cookieParser = _cookieParser;
  static methodOverride = _methodOverride;
  private static instance: Service | null = null;
  static getInstance(envConfig?: EnvironmentConfig) {
    if (!Service.instance) {
      if (!envConfig) {
        throw new Error('envConfig is required');
      }
      Service.instance = new Service(envConfig);
    }
    return Service.instance;
  }

  name?: string;
  port?: number;
  useMongo?: boolean;
  useRedis?: boolean;
  useAxios?: boolean;
  useRequestParsers?: boolean;
  exposeHealthCheck?: boolean;
  onStartUp?: (express: Express.Application) => Promise<void>;
  onShutDown?: () => Promise<void>;

  mongoClient?: MongoClient;
  redisClient?: RedisClient;
  private httpServer?: ReturnType<Express.Application['listen']>;

  envConfig: EnvironmentConfig;
  expressServer: Express.Application;

  private constructor(envConfig: EnvironmentConfig) {
    this.envConfig = envConfig;
    this.expressServer = Express();
  }

  async init({
    name,
    useMongo,
    useRedis,
    useAxios,
    useRequestParsers = true,
    exposeHealthCheck = true,
    onStartUp,
    onShutDown
  }: ServiceOptions) {
    this.name = name;
    this.port = this.envConfig.getValues().PORT;
    this.useAxios = useAxios;
    this.useRequestParsers = useRequestParsers;
    this.exposeHealthCheck = exposeHealthCheck;
    this.onStartUp = onStartUp;
    this.onShutDown = onShutDown;
    this.useMongo = useMongo;
    this.useRedis = useRedis;

    if (useMongo) {
      this.mongoClient = MongoClient.getInstance(this.envConfig);
    }

    if (useRedis) {
      this.redisClient = RedisClient.getInstance(this.envConfig);
    }

    if (this.useAxios) {
      httpInterceptors();
    }

    if (this.useRequestParsers) {
      this.expressServer.use(_cookieParser() as any);
      this.expressServer.use(Express.urlencoded({ extended: true }));
      // E6: keep the global JSON limit at Express's default (100kb). The
      // earlier 50mb override applied to every endpoint in every service —
      // a single huge POST anywhere could exhaust process memory. The
      // database-restore endpoint that legitimately needs the big cap
      // installs its own `express.json({ limit: '50mb' })` per-route at
      // services/api/src/routes.ts. We skip the global parser on that
      // path so the per-route parser (which actually lifts the cap) is
      // the first to run when the request arrives — without this skip,
      // body-parser raises 413 here before the per-route middleware ever
      // sees the request.
      this.expressServer.use((req, res, next) => {
        if (req.path === '/api/v2/database/restore') {
          return next();
        }
        return Express.json()(req, res, next);
      });
      this.expressServer.use(_methodOverride() as any);
      if (this.useMongo) {
        this.expressServer.use(mongoSanitize({
          allowDots: true,
          replaceWith: '_',
          onSanitize: ({ key }: { req: Express.Request; key: string }) => {
            Logger.default.warn(`request[${key}] has been sanitized`);
          }
        }) as any);
      }
    }

    this.expressServer.use(
      expressWinston.logger({
        transports: Logger.transports,
        format: winston.format.simple(),
        meta: false, // optional: control whether you want to log the meta data about the request (default to true)
        msg: '{{req.method}} {{res.statusCode}} {{res.responseTime}}ms {{req.url}}', //'HTTP {{req.method}} {{req.url}}', // optional: customize the default logging message. E.g. "{{res.statusCode}} {{req.method}} {{res.responseTime}}ms {{req.url}}"
        expressFormat: false, // Use the default Express/morgan request formatting. Enabling this will override any msg if true. Will only output colors with colorize set to true
        colorize: false // Color the text and status code, using the Express/morgan color palette (text: gray, status: default green, 3XX cyan, 4XX yellow, 5XX red).
      })
    );
  }

  private async startService() {
    return new Promise<void>((resolve, reject) => {
      this.httpServer = this.expressServer
        .listen(this.port, () => {
          Logger.default.info(
            `${this.name} ready and listening on port ${this.port}`
          );
          resolve();
        })
        .on('error', async (err) => {
          Logger.default.error(String(err));
          if (this.mongoClient) {
            try {
              await this.mongoClient.disconnect();
            } catch (error) {
              Logger.default.error(String(error));
            }
          }
          if (this.redisClient) {
            try {
              await this.redisClient.disconnect();
            } catch (error) {
              Logger.default.error(String(error));
            }
          }
          reject(err);
        });
    });
  }

  async startUp() {
    Logger.default.info(`Starting ${this.name}...`);
    this.envConfig.log();
    if (this.mongoClient) {
      await this.mongoClient.connect();
    }
    if (this.redisClient) {
      await this.redisClient.connect();
      // await this.redisClient.monitor();
    }

    if (this.exposeHealthCheck) {
      this.expressServer.get('/health', async (req, res) => {
        // Verify dependencies are reachable. A naive 200 was misleading:
        // load balancers and orchestrators read /health to decide whether
        // to route traffic; if mongo or redis went away the service kept
        // claiming healthy, masking the real outage.
        const checks: Record<string, string> = { service: 'ok' };
        let healthy = true;

        if (this.mongoClient) {
          try {
            const state = (this.mongoClient as any)?.connection?.readyState;
            // 1 = connected (mongoose). Anything else means we are not
            // ready to serve requests that depend on mongo.
            if (state === 1) {
              checks.mongo = 'ok';
            } else {
              checks.mongo = 'down(state=' + state + ')';
              healthy = false;
            }
          } catch (e) {
            checks.mongo = 'error';
            healthy = false;
          }
        }

        if (this.redisClient) {
          try {
            // E5: RedisClient now exposes a typed `isOpen` getter that
            // proxies node-redis's underlying connection liveness. The
            // previous guard `(redisClient as any).isOpen !== undefined`
            // skipped the check entirely because the wrapper class did
            // not declare the property — every healthy redis was reported
            // as 'down' by silent omission.
            if (this.redisClient.isOpen) {
              checks.redis = 'ok';
            } else {
              checks.redis = 'down';
              healthy = false;
            }
          } catch (e) {
            checks.redis = 'error';
            healthy = false;
          }
        }

        res.status(healthy ? 200 : 503).json(checks);
      });
    }

    await this.onStartUp?.(this.expressServer);

    // add error middleware
    this.expressServer.use(Middlewares.errorHandler);
    await this.startService();
  }

  async shutDown(errCode: number) {
    if (this.httpServer) {
      try {
        await new Promise<void>((resolve) => {
          this.httpServer!.close(() => resolve());
          setTimeout(resolve, 5000);
        });
        Logger.default.info('HTTP server closed');
      } catch (error) {
        Logger.default.error(`Error closing HTTP server: ${error}`);
      }
    }
    if (this.mongoClient) {
      try {
        await this.mongoClient.disconnect();
      } catch (error) {
        Logger.default.error(String(error));
      }
    }
    if (this.redisClient) {
      try {
        await this.redisClient.disconnect();
      } catch (error) {
        Logger.default.error(String(error));
      }
    }
    await this.onShutDown?.();
    process.exit(errCode);
  }

  async createServiceToken(role: ConnectionRole, realmId: string) {
    const { ACCESS_TOKEN_SECRET } = this.envConfig.getValues();
    if (!ACCESS_TOKEN_SECRET) {
      throw new Error('ACCESS_TOKEN_SECRET is required');
    }

    const service: InternalServicePrincipal = {
      type: 'service',
      serviceId: this.name || 'unknown',
      realmId,
      role
    };
    const accessToken = jwt.sign({ service }, ACCESS_TOKEN_SECRET, {
      expiresIn: '30s'
    });

    return accessToken;
  }
}
