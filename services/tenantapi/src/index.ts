import * as Express from 'express';
import {
  EnvironmentConfig,
  logger,
  Middlewares,
  Service
} from '@microrealestate/common';
import routes from './routes.js';

Main();

async function onStartUp(application: Express.Application) {
  // Tenant sessionToken cookies are long-lived. The authenticator's /signout
  // handler revokes a session by deleting the cookie value from Redis. We pass
  // the redis client to needAccessToken so this middleware verifies the token
  // is still present in the store on every request — otherwise a stolen or
  // signed-out cookie would continue to grant access until JWT expiry.
  const redisClient = Service.getInstance().redisClient;
  application.use(
    Middlewares.needAccessToken(
      Service.getInstance().envConfig.getValues().ACCESS_TOKEN_SECRET,
      redisClient
        ? {
            get: (key: string) => redisClient.get(key) as Promise<string | null>
          }
        : undefined
    ),
    Middlewares.checkOrganization(),
    Middlewares.onlyTypes(['user']),
    Middlewares.onlyRoles(['tenant'])
  );
  application.use('/tenantapi', routes);
}

async function Main() {
  let service;
  try {
    service = Service.getInstance(
      new EnvironmentConfig({
        DEMO_MODE: process.env.DEMO_MODE
          ? process.env.DEMO_MODE.toLowerCase() === 'true'
          : undefined
      })
    );

    await service.init({
      name: 'tenantapi',
      useRequestParsers: true,
      useMongo: true,
      onStartUp
    });

    await service.startUp();
  } catch (error) {
    logger.error(String(error));
    service?.shutDown(-1);
  }
}
