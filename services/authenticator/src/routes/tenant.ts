import {
  Collections,
  logger,
  Middlewares,
  Service,
  ServiceError
} from '@microrealestate/common';
import { authRateLimit } from './index.js';
import axios from 'axios';
import { customAlphabet } from 'nanoid';
import express, { Router } from 'express';
import jwt from 'jsonwebtoken';
import { Request, Response } from 'express';

// 6-digit OTP — landlord/tenant UIs render six input boxes.
const nanoid = customAlphabet('0123456789ABCDEFGHJKLMNPQRSTUVWXYZ', 6);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function (): Router {
  const {
    EMAILER_URL,
    ACCESS_TOKEN_SECRET,
    TOKEN_COOKIE_ATTRIBUTES,
    PRODUCTION
  } = Service.getInstance().envConfig.getValues() as any;
  const tenantRouter = express.Router();

  tenantRouter.post(
    '/signin',
    authRateLimit,
    Middlewares.asyncWrapper(async (req: Request, res: Response) => {
      const rawEmail = req.body?.email;
      if (typeof rawEmail !== 'string') {
        throw new ServiceError('email must be a string', 422);
      }
      const email = rawEmail.trim().toLowerCase();
      if (!email) {
        logger.error('missing email field');
        throw new ServiceError('missing fields', 422);
      }

      if (!EMAIL_RE.test(email)) {
        logger.warn('invalid email format');
        throw new ServiceError('unsupported email', 422);
      }

      const tenants = await Collections.Tenant.find({
        'contacts.email': { $eq: email }
      });
      if (!tenants.length) {
        logger.info(`login failed for ${email} tenant not found`);
        // Constant-time-ish behavior: still return 204 immediately so the
        // unknown-tenant branch is indistinguishable from the known one.
        return res.sendStatus(204);
      }

      const otp = nanoid();
      const now = new Date();
      const createdAt = now.getTime();
      const expiresAt = createdAt + 5 * 60 * 1000; // 5m
      await Service.getInstance().redisClient!.set(
        otp,
        `createdAt=${createdAt};expiresAt=${expiresAt};email=${email}`,
        { EX: 300 }
      );

      logger.debug(`OTP created for email ${email} on domain ${req.hostname}`);

      // Fire-and-forget: do not await the emailer so the known-tenant
      // branch returns in roughly the same time as the unknown-tenant
      // branch (no email-delivery timing leak).
      axios
        .post(
          `${EMAILER_URL}/otp`,
          {
            templateName: 'otp',
            recordId: email,
            params: {
              otp
            }
          },
          {
            headers: {
              'Accept-Language': (req as any).rawLocale.code
            }
          }
        )
        .catch((err: any) => {
          logger.error(
            `failed to dispatch OTP email for ${email}: ${err?.message || err}`
          );
        });

      res.sendStatus(204);
    })
  );

  tenantRouter.delete(
    '/signout',
    Middlewares.asyncWrapper(async (req: Request, res: Response) => {
      const sessionToken = req.cookies.sessionToken;
      logger.debug('session token removal requested');
      if (!sessionToken) {
        return res.sendStatus(204);
      }

      await Service.getInstance().redisClient!.del(sessionToken);
      res.clearCookie('sessionToken', TOKEN_COOKIE_ATTRIBUTES);
      res.sendStatus(204);
    })
  );

  // Shared handler for GET (otp via query) and POST (otp via body). The
  // landlord/tenant frontend sends POST after the recent client refactor;
  // we keep GET for backward compat with bookmarked email-link flows.
  const signedInHandler = (otpSource: 'query' | 'body') =>
    Middlewares.asyncWrapper(async (req: Request, res: Response) => {
      const rawOtp =
        otpSource === 'query' ? req.query.otp : (req.body || {}).otp;
      // Type-confusion (array, object, number) → 422 so it's distinct from
      // wrong/expired credentials. Mirrors the landlord typeof guards.
      if (rawOtp !== undefined && typeof rawOtp !== 'string') {
        throw new ServiceError('otp must be a string', 422);
      }
      if (!rawOtp || !rawOtp.trim()) {
        throw new ServiceError('invalid otp', 401);
      }
      const otp = rawOtp;

      const rawPayload = await Service.getInstance().redisClient!.get(otp);
      if (!rawPayload) {
        // Plain ServiceError(401). The error handler (in common middlewares)
        // is responsible for stripping the stack from the response body —
        // do not include any extra detail here that might leak via
        // err.cause / err.stack on a misconfigured error handler.
        throw new ServiceError('invalid or expired OTP', 401);
      }
      await Service.getInstance().redisClient!.del(otp);

      const payload = rawPayload
        .split(';')
        .reduce<Record<string, string>>((acc, rawValue) => {
          const [key, value] = rawValue.split('=');
          if (key) {
            acc[key] = value;
          }
          return acc;
        }, {});

      const now = new Date().getTime();
      const expiresAt = Number(payload.expiresAt) || 0;
      if (now > expiresAt) {
        // Don't log the OTP value itself.
        logger.debug('otp expired');
        throw new ServiceError('invalid otp', 401);
      }

      const account = { email: payload.email, role: 'tenant' };
      const sessionToken = jwt.sign({ account }, ACCESS_TOKEN_SECRET!, {
        expiresIn: PRODUCTION ? '30m' : '12h'
      });
      await Service.getInstance().redisClient!.set(
        sessionToken,
        payload.email,
        {
          EX: PRODUCTION ? 1800 : 43200
        }
      );
      // Cookie-only — never echo the sessionToken in the JSON body. Tokens
      // in body get logged by intermediate proxies, captured by browser
      // history extensions, and dragged into client-side error reports.
      res.cookie('sessionToken', sessionToken, TOKEN_COOKIE_ATTRIBUTES);
      return res.sendStatus(200);
    });

  tenantRouter.get('/signedin', authRateLimit, signedInHandler('query'));
  tenantRouter.post('/signedin', authRateLimit, signedInHandler('body'));

  tenantRouter.get(
    '/session',
    Middlewares.asyncWrapper(async (req: Request, res: Response) => {
      const sessionToken = req.cookies.sessionToken;
      if (!sessionToken) {
        throw new ServiceError('invalid token', 401);
      }

      const email = await Service.getInstance().redisClient!.get(sessionToken);
      if (!email) {
        logger.error('session token not found in store');
        throw new ServiceError('invalid token', 401);
      }

      try {
        jwt.verify(sessionToken, ACCESS_TOKEN_SECRET!, { algorithms: ['HS256'] });
      } catch (error) {
        throw new ServiceError(error as string, 401);
      }

      return res.json({ email });
    })
  );

  return tenantRouter;
}
