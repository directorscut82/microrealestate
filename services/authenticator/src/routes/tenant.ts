import {
  Collections,
  logger,
  Middlewares,
  Service,
  ServiceError
} from '@microrealestate/common';
import axios from 'axios';
import { customAlphabet } from 'nanoid';
import express, { Router } from 'express';
import jwt from 'jsonwebtoken';
import { Request, Response } from 'express';

const nanoid = customAlphabet('0123456789ABCDEFGHJKLMNPQRSTUVWXYZ', 8);

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
    Middlewares.asyncWrapper(async (req: Request, res: Response) => {
      let { email } = req.body;
      email = email?.trim().toLowerCase();
      if (!email) {
        logger.error('missing email field');
        throw new ServiceError('missing fields', 422);
      }

      if (!EMAIL_RE.test(email)) {
        logger.error('invalid email format');
        throw new ServiceError('unsupported email', 422);
      }

      const tenants = await Collections.Tenant.find({
        'contacts.email': { $eq: email }
      });
      if (!tenants.length) {
        logger.info(`login failed for ${email} tenant not found`);
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

      await axios.post(
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
      );

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

  tenantRouter.get(
    '/signedin',
    Middlewares.asyncWrapper(async (req: Request, res: Response) => {
      const { otp } = req.query;
      if (!otp) {
        throw new ServiceError('invalid otp', 401);
      }

      const rawPayload = await Service.getInstance().redisClient!.get(otp as string);
      if (!rawPayload) {
        throw new ServiceError('invalid or expired OTP',
          401
        );
      }
      await Service.getInstance().redisClient!.del(otp as string);

      const payload = rawPayload.split(';').reduce<Record<string, string>>((acc, rawValue) => {
        const [key, value] = rawValue.split('=');
        if (key) {
          acc[key] = value;
        }
        return acc;
      }, {});

      const now = new Date().getTime();
      const expiresAt = Number(payload.expiresAt) || 0;
      if (now > expiresAt) {
        logger.debug(`otp ${otp} has expired`);
        throw new ServiceError('invalid otp', 401);
      }

      const account = { email: payload.email, role: 'tenant' };
      const sessionToken = jwt.sign({ account }, ACCESS_TOKEN_SECRET!, {
        expiresIn: PRODUCTION ? '30m' : '12h'
      });
      await Service.getInstance().redisClient!.set(sessionToken, payload.email, {
        EX: PRODUCTION ? 1800 : 43200
      });
      res.cookie('sessionToken', sessionToken, TOKEN_COOKIE_ATTRIBUTES);
      res.json({ sessionToken });
    })
  );

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
