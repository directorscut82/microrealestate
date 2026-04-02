import * as accountingManager from './managers/accountingmanager.js';
import * as dashboardManager from './managers/dashboardmanager.js';
import * as emailManager from './managers/emailmanager.js';
import * as leaseManager from './managers/leasemanager.js';
import * as occupantManager from './managers/occupantmanager.js';
import * as propertyManager from './managers/propertymanager.js';
import * as realmManager from './managers/realmmanager.js';
import * as rentManager from './managers/rentmanager.js';
import { Middlewares, Service } from '@microrealestate/common';
import express from 'express';

export default function routes(): express.Router {
  const { ACCESS_TOKEN_SECRET } = Service.getInstance().envConfig.getValues();
  const router = express.Router();
  router.use(
    Middlewares.needAccessToken(ACCESS_TOKEN_SECRET as string),
    Middlewares.checkOrganization(),
    Middlewares.notRoles(['tenant'])
  );

  const realmsRouter = express.Router();
  realmsRouter.get('/', realmManager.all as any);
  realmsRouter.get('/:id', realmManager.one as any);
  realmsRouter.post('/', Middlewares.asyncWrapper(realmManager.add as any));
  realmsRouter.patch('/:id', Middlewares.asyncWrapper(realmManager.update as any));
  router.use('/realms', realmsRouter);

  const dashboardRouter = express.Router();
  dashboardRouter.get('/', Middlewares.asyncWrapper(dashboardManager.all as any));
  router.use('/dashboard', dashboardRouter);

  const leasesRouter = express.Router();
  leasesRouter.get('/', Middlewares.asyncWrapper(leaseManager.all as any));
  leasesRouter.get('/:id', Middlewares.asyncWrapper(leaseManager.one as any));
  leasesRouter.post('/', Middlewares.asyncWrapper(leaseManager.add as any));
  leasesRouter.patch('/:id', Middlewares.asyncWrapper(leaseManager.update as any));
  leasesRouter.delete('/:ids', Middlewares.asyncWrapper(leaseManager.remove as any));
  router.use('/leases', leasesRouter);

  const occupantsRouter = express.Router();
  occupantsRouter.get('/', Middlewares.asyncWrapper(occupantManager.all as any));
  occupantsRouter.get('/:id', Middlewares.asyncWrapper(occupantManager.one as any));
  occupantsRouter.post('/', Middlewares.asyncWrapper(occupantManager.add as any));
  occupantsRouter.patch(
    '/:id',
    Middlewares.asyncWrapper(occupantManager.update as any)
  );
  occupantsRouter.delete(
    '/:ids',
    Middlewares.asyncWrapper(occupantManager.remove as any)
  );
  router.use('/tenants', occupantsRouter);

  const rentsRouter = express.Router();
  rentsRouter.patch(
    '/payment/:id/:term',
    Middlewares.asyncWrapper(rentManager.updateByTerm as any)
  );
  rentsRouter.get(
    '/tenant/:id',
    Middlewares.asyncWrapper(rentManager.rentsOfOccupant as any)
  );
  rentsRouter.get(
    '/tenant/:id/:term',
    Middlewares.asyncWrapper(rentManager.rentOfOccupantByTerm as any)
  );
  rentsRouter.get('/:year/:month', Middlewares.asyncWrapper(rentManager.all as any));
  router.use('/rents', rentsRouter);

  const propertiesRouter = express.Router();
  propertiesRouter.get('/', Middlewares.asyncWrapper(propertyManager.all as any));
  propertiesRouter.get('/:id', Middlewares.asyncWrapper(propertyManager.one as any));
  propertiesRouter.post('/', Middlewares.asyncWrapper(propertyManager.add as any));
  propertiesRouter.patch(
    '/:id',
    Middlewares.asyncWrapper(propertyManager.update as any)
  );
  propertiesRouter.delete(
    '/:ids',
    Middlewares.asyncWrapper(propertyManager.remove as any)
  );
  router.use('/properties', propertiesRouter);

  router.get(
    '/accounting/:year',
    Middlewares.asyncWrapper(accountingManager.all as any)
  );
  router.get(
    '/csv/tenants/incoming/:year',
    Middlewares.asyncWrapper(accountingManager.csv.incomingTenants as any)
  );
  router.get(
    '/csv/tenants/outgoing/:year',
    Middlewares.asyncWrapper(accountingManager.csv.outgoingTenants as any)
  );
  router.get(
    '/csv/settlements/:year',
    Middlewares.asyncWrapper(accountingManager.csv.settlements as any)
  );

  const emailRouter = express.Router();
  emailRouter.post('/', Middlewares.asyncWrapper(emailManager.send as any));
  router.use('/emails', emailRouter);

  // Presence awareness — shows who else is viewing the same record
  router.post('/presence/:type/:id', Middlewares.asyncWrapper(async (req: any, res: any) => {
    const { type, id } = req.params;
    const redis = Service.getInstance().redisClient;
    const key = `presence:${req.realm._id}:${type}:${id}:${req.user.email}`;
    const value = JSON.stringify({ name: `${req.user.firstname} ${req.user.lastname}`, email: req.user.email });
    await redis!.set(key, value, { EX: 60 });
    // Get all viewers
    const pattern = `presence:${req.realm._id}:${type}:${id}:*`;
    const keys = await redis!.keys(pattern);
    const viewers = [];
    for (const k of keys) {
      const v = await redis!.get(k);
      if (v) viewers.push(JSON.parse(v));
    }
    res.json(viewers.filter((v: any) => v.email !== req.user.email));
  }));

  router.get('/presence/:type/:id', Middlewares.asyncWrapper(async (req: any, res: any) => {
    const { type, id } = req.params;
    const redis = Service.getInstance().redisClient;
    const pattern = `presence:${req.realm._id}:${type}:${id}:*`;
    const keys = await redis!.keys(pattern);
    const viewers = [];
    for (const k of keys) {
      const v = await redis!.get(k);
      if (v) viewers.push(JSON.parse(v));
    }
    res.json(viewers.filter((v: any) => v.email !== req.user.email));
  }));

  const apiRouter = express.Router();
  apiRouter.use('/api/v2', router);

  return apiRouter;
}
