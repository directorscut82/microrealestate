import * as accountingManager from './managers/accountingmanager.js';
import * as billManager from './managers/billmanager.js';
import * as buildingManager from './managers/buildingmanager.js';
import * as dashboardManager from './managers/dashboardmanager.js';
import * as emailManager from './managers/emailmanager.js';
import * as leaseManager from './managers/leasemanager.js';
import * as occupantManager from './managers/occupantmanager.js';
import * as propertyManager from './managers/propertymanager.js';
import * as realmManager from './managers/realmmanager.js';
import * as rentManager from './managers/rentmanager.js';
import { Middlewares, Service, ServiceError } from '@microrealestate/common';
import express from 'express';
import multer from 'multer';
import { logger } from '@microrealestate/common';
import { parseImportedPdf } from './managers/pdfimportmanager.js';

// Validate that a string looks like a MongoDB ObjectId
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
function isValidObjectId(id: unknown): boolean {
  return typeof id === 'string' && OBJECT_ID_RE.test(id);
}

// Simple in-memory rate limiter for upload endpoints (no external dep)
const uploadRateLimits = new Map<string, { count: number; resetAt: number }>();
const UPLOAD_RATE_WINDOW_MS = 60_000; // 1 minute
const UPLOAD_RATE_MAX = 10; // 10 uploads per minute per user

function uploadRateLimit(req: any, res: any, next: any) {
  const key = `${req.realm?._id}:${req.user?.email || req.ip}`;
  const now = Date.now();
  const entry = uploadRateLimits.get(key);
  if (!entry || now > entry.resetAt) {
    uploadRateLimits.set(key, { count: 1, resetAt: now + UPLOAD_RATE_WINDOW_MS });
    return next();
  }
  if (entry.count >= UPLOAD_RATE_MAX) {
    return res.status(429).json({ message: 'Too many uploads, please try again later' });
  }
  entry.count++;
  return next();
}

// Verify uploaded file starts with PDF magic bytes
function verifyPdfContent(req: any, res: any, next: any) {
  const files = req.file ? [req.file] : (req.files || []);
  for (const file of files) {
    if (file && file.buffer) {
      if (file.buffer.length < 4 || file.buffer.slice(0, 4).toString() !== '%PDF') {
        return res.status(422).json({
          message: `Invalid PDF file content: ${file.originalname || 'unknown'}`
        });
      }
    }
  }
  return next();
}

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
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (file.mimetype === 'application/pdf') {
        cb(null, true);
      } else {
        cb(new ServiceError('Only PDF files are allowed', 422));
      }
    }
  });
  occupantsRouter.post(
    '/import-pdf',
    uploadRateLimit, upload.single('pdf') as any, verifyPdfContent,
    Middlewares.asyncWrapper(parseImportedPdf as any)
  );
  occupantsRouter.get('/', Middlewares.asyncWrapper(occupantManager.all as any));
  occupantsRouter.put('/:id/archive', Middlewares.asyncWrapper(occupantManager.archive as any));
  occupantsRouter.put('/:id/unarchive', Middlewares.asyncWrapper(occupantManager.unarchive as any));
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

  const buildingsRouter = express.Router();
  buildingsRouter.post(
    '/import-pdf',
    uploadRateLimit, upload.single('pdf') as any, verifyPdfContent,
    Middlewares.asyncWrapper(buildingManager.importFromE9 as any)
  );
  buildingsRouter.get('/', Middlewares.asyncWrapper(buildingManager.all as any));
  buildingsRouter.get('/:id', Middlewares.asyncWrapper(buildingManager.one as any));
  buildingsRouter.post('/', Middlewares.asyncWrapper(buildingManager.add as any));
  buildingsRouter.patch('/:id', Middlewares.asyncWrapper(buildingManager.update as any));
  buildingsRouter.delete('/:ids', Middlewares.asyncWrapper(buildingManager.remove as any));
  // Units
  buildingsRouter.post('/:id/units', Middlewares.asyncWrapper(buildingManager.addUnit as any));
  buildingsRouter.patch('/:id/units/:unitId', Middlewares.asyncWrapper(buildingManager.updateUnit as any));
  buildingsRouter.delete('/:id/units/:unitId', Middlewares.asyncWrapper(buildingManager.removeUnit as any));
  // Monthly charges
  buildingsRouter.post('/:id/units/:unitId/charges', Middlewares.asyncWrapper(buildingManager.addMonthlyCharge as any));
  buildingsRouter.patch('/:id/units/:unitId/charges/:chargeId', Middlewares.asyncWrapper(buildingManager.updateMonthlyCharge as any));
  buildingsRouter.delete('/:id/units/:unitId/charges/:chargeId', Middlewares.asyncWrapper(buildingManager.removeMonthlyCharge as any));
  // Expenses
  buildingsRouter.post('/:id/expenses', Middlewares.asyncWrapper(buildingManager.addExpense as any));
  buildingsRouter.patch('/:id/expenses/:expenseId', Middlewares.asyncWrapper(buildingManager.updateExpense as any));
  buildingsRouter.delete('/:id/expenses/:expenseId', Middlewares.asyncWrapper(buildingManager.removeExpense as any));
  // Contractors
  buildingsRouter.post('/:id/contractors', Middlewares.asyncWrapper(buildingManager.addContractor as any));
  // Monthly statement (batch distribution of expenses to units for a given month)
  buildingsRouter.post('/:id/monthly-statement', Middlewares.asyncWrapper(buildingManager.saveMonthlyStatement as any));
  buildingsRouter.patch('/:id/contractors/:contractorId', Middlewares.asyncWrapper(buildingManager.updateContractor as any));
  buildingsRouter.delete('/:id/contractors/:contractorId', Middlewares.asyncWrapper(buildingManager.removeContractor as any));
  // Repairs
  buildingsRouter.post('/:id/repairs', Middlewares.asyncWrapper(buildingManager.addRepair as any));
  buildingsRouter.patch('/:id/repairs/:repairId', Middlewares.asyncWrapper(buildingManager.updateRepair as any));
  buildingsRouter.delete('/:id/repairs/:repairId', Middlewares.asyncWrapper(buildingManager.removeRepair as any));
  router.use('/buildings', buildingsRouter);

  // Bills
  const billsRouter = express.Router();
  billsRouter.get('/', Middlewares.asyncWrapper(billManager.list as any));
  billsRouter.get('/:id', Middlewares.asyncWrapper(billManager.one as any));
  billsRouter.post('/parse', uploadRateLimit, upload.array('bills', 5) as any, verifyPdfContent, Middlewares.asyncWrapper(billManager.parseBills as any));
  billsRouter.post('/confirm', Middlewares.asyncWrapper(billManager.confirmBills as any));
  billsRouter.post('/payment-receipt', uploadRateLimit, upload.array('bills', 5) as any, verifyPdfContent, Middlewares.asyncWrapper(billManager.parsePaymentReceipts as any));
  billsRouter.post('/confirm-payment', Middlewares.asyncWrapper(billManager.confirmPayment as any));
  router.use('/bills', billsRouter);

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
  emailRouter.post('/sms', Middlewares.asyncWrapper(emailManager.sendSmsOnly as any));
  router.use('/emails', emailRouter);

  // Presence awareness — shows who else is viewing the same record
  const PRESENCE_TTL = 60;

  // Lua script for atomic presence update (prevents read-modify-write race)
  const PRESENCE_LUA = `
    local key = KEYS[1]
    local email = ARGV[1]
    local name = ARGV[2]
    local now = tonumber(ARGV[3])
    local ttl = tonumber(ARGV[4])
    local raw = redis.call('GET', key)
    local viewers = raw and cjson.decode(raw) or {}
    viewers[email] = { name = name, email = email, ts = now }
    for e, v in pairs(viewers) do
      if now - v.ts > (ttl * 1000) then viewers[e] = nil end
    end
    redis.call('SETEX', key, ttl, cjson.encode(viewers))
    return cjson.encode(viewers)
  `;

  router.post('/presence/:type/:id', Middlewares.asyncWrapper(async (req: any, res: any) => {
    const { type, id } = req.params;
    const redis = Service.getInstance().redisClient;
    if (!redis) {
      res.json([]);
      return;
    }
    try {
      const setKey = `presence:${req.realm._id}:${type}:${id}`;
      const member = req.realm.members?.find((m: any) => m.email === req.user.email);
      const name = member?.name || req.user.email;
      const now = Date.now();
      const rawResult = await (redis as any).eval(PRESENCE_LUA, {
        keys: [setKey],
        arguments: [req.user.email, name, String(now), String(PRESENCE_TTL)]
      }) as string;
      const viewers: Record<string, any> = rawResult ? JSON.parse(rawResult) : {};
      const result = Object.values(viewers)
        .filter((v: any) => v.email !== req.user.email)
        .map(({ name: n }: any) => ({ name: n }));
      res.json(result);
    } catch (error) {
      logger.error(`Presence POST error: ${error}`);
      res.json([]);
    }
  }));

  router.get('/presence/:type/:id', Middlewares.asyncWrapper(async (req: any, res: any) => {
    const { type, id } = req.params;
    const redis = Service.getInstance().redisClient;
    if (!redis) {
      res.json([]);
      return;
    }
    try {
      const setKey = `presence:${req.realm._id}:${type}:${id}`;
      const raw = await redis.get(setKey);
      if (!raw) { res.json([]); return; }
      const viewers: Record<string, any> = JSON.parse(raw);
      const now = Date.now();
      const result = Object.values(viewers)
        .filter((v: any) => v.email !== req.user.email && (now - v.ts) < PRESENCE_TTL * 1000)
        .map(({ name: n }: any) => ({ name: n }));
      res.json(result);
    } catch (error) {
      logger.error(`Presence GET error: ${error}`);
      res.json([]);
    }
  }));

  const apiRouter = express.Router();
  apiRouter.use('/api/v2', router);

  return apiRouter;
}
