import {
  Collections,
  logger,
  Middlewares,
  Service,
  ServiceError
} from '@microrealestate/common';
import { authRateLimit } from './index.js';
import { redactEmail } from '../utils/redact.js';
import axios from 'axios';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import express, { Router } from 'express';
import jwt from 'jsonwebtoken';
import locale from 'locale';
import { Request, Response } from 'express';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

const _generateTokens = async (dbAccount: Record<string, any>): Promise<{ refreshToken: string; accessToken: string }> => {
  const { REFRESH_TOKEN_SECRET, ACCESS_TOKEN_SECRET, PRODUCTION } =
    Service.getInstance().envConfig.getValues();
  const { _id, password, ...account } = dbAccount;
  const refreshToken = jwt.sign({ account }, REFRESH_TOKEN_SECRET!, {
    expiresIn: PRODUCTION ? '600s' : '12h'
  });
  const accessToken = jwt.sign({ account }, ACCESS_TOKEN_SECRET!, {
    expiresIn: '5m'
  });

  await Service.getInstance().redisClient!.set(refreshToken, accessToken, {
    EX: PRODUCTION ? 600 : 43200
  });

  return { refreshToken, accessToken };
};

// Atomic GET+DEL of the refresh token to prevent the classic
//   GET (valid) -> verify -> DEL  race
// where two concurrent refresh requests would both see the token as valid,
// both delete it, and both mint new tokens (allowing replay).
// Returns the token's payload on success, null otherwise.
const _consumeRefreshToken = async (oldRefreshToken: string): Promise<string | null> => {
  const redis = Service.getInstance().redisClient!;
  const client: any = (redis as any).client || redis;

  // ioredis exposes getdel; node-redis v4 exposes GETDEL via the modern API.
  // Fall back to a Lua script otherwise.
  if (typeof client.getdel === 'function') {
    return await client.getdel(oldRefreshToken);
  }
  if (typeof client.GETDEL === 'function') {
    return await client.GETDEL(oldRefreshToken);
  }
  if (typeof client.eval === 'function') {
    const script =
      "local v = redis.call('GET', KEYS[1]); if v then redis.call('DEL', KEYS[1]); end; return v";
    return (await client.eval(script, 1, oldRefreshToken)) as string | null;
  }
  // Last-resort fallback (non-atomic) — should never hit in practice.
  const value = await client.get(oldRefreshToken);
  if (value) {
    await client.del(oldRefreshToken);
  }
  return value;
};

const _refreshTokens = async (oldRefreshToken: string): Promise<{ refreshToken?: string; accessToken?: string }> => {
  const { REFRESH_TOKEN_SECRET } = Service.getInstance().envConfig.getValues();

  // Atomic consume: only the first concurrent request wins.
  const oldAccessToken = await _consumeRefreshToken(oldRefreshToken);
  if (!oldAccessToken) {
    logger.warn('refresh token not found in database');
    return {};
  }

  let account: Record<string, any> | undefined;
  try {
    const payload = jwt.verify(oldRefreshToken, REFRESH_TOKEN_SECRET!, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    if (payload?.account) {
      account = payload.account;
    }
  } catch (exc) {
    logger.error('refresh token verification failed', { error: (exc as Error)?.message });
  }

  if (!account) {
    return {};
  }

  return await _generateTokens(account);
};

const _clearTokens = async (refreshToken: string): Promise<void> => {
  await Service.getInstance().redisClient!.del(refreshToken);
};

const _applicationSignIn = Middlewares.asyncWrapper(async (req: Request, res: Response) => {
  const { APPCREDZ_TOKEN_SECRET, ACCESS_TOKEN_SECRET } =
    Service.getInstance().envConfig.getValues();
  const { clientId, clientSecret } = req.body;
  if (
    [clientId, clientSecret].some((el) => !el || !String(el).trim())
  ) {
    logger.error('M2M login failed some fields are missing');
    throw new ServiceError('missing fields', 422);
  }

  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(clientSecret, APPCREDZ_TOKEN_SECRET!, { algorithms: ['HS256'] }) as jwt.JwtPayload;
  } catch (exc) {
    if (exc instanceof jwt.TokenExpiredError) {
      // organizationId is unknown here — the token expired before we could
      // parse it. Log only what we actually have.
      logger.info(`login failed for application ${clientId}: expired token`);
      throw new ServiceError('expired clientId', 401);
    } else {
      throw new ServiceError('invalid credentials', 401);
    }
  }

  let organizationId: string | undefined;
  let keyId: string | undefined;
  if (payload?.organizationId && payload?.jti) {
    organizationId = payload.organizationId;
    keyId = payload.jti;
  } else {
    logger.error(
      'Provided clientSecret is valid but does not have required fields'
    );
    throw new ServiceError('invalid credentials', 401);
  }

  if (clientId !== keyId) {
    logger.info(
      `login failed for application ${clientId}@${organizationId}: clientId & clientSecret not matching`
    );
    throw new ServiceError('invalid credentials', 401);
  }

  const realm = (
    await Collections.Realm.findOne({ _id: organizationId })
  )?.toObject();
  if (!realm) {
    logger.info(
      `login failed for application ${clientId}@${organizationId}: realm not found`
    );
    throw new ServiceError('invalid credentials', 401);
  }
  const application = (realm as any).applications?.find(
    (app: any) => app?.clientId === clientId
  );
  if (!application) {
    logger.info(
      `login failed for application ${clientId}@${organizationId}: appplication revoked`
    );
    throw new ServiceError('revoked clientId', 401);
  }

  const validSecret = await bcrypt.compare(
    clientSecret,
    application.clientSecret
  );
  if (!validSecret) {
    logger.info(
      `login failed for application ${clientId}@${organizationId}: bad secret`
    );
    throw new ServiceError('invalid credentials', 401);
  }

  delete application.clientSecret;
  const accessToken = jwt.sign({ application }, ACCESS_TOKEN_SECRET!, {
    expiresIn: '300s'
  });

  res.json({ accessToken, organizationId });
});

const _userSignIn = Middlewares.asyncWrapper(async (req: Request, res: Response) => {
  const { TOKEN_COOKIE_ATTRIBUTES } =
    Service.getInstance().envConfig.getValues() as any;
  const { email: rawEmail, password } = req.body;
  if (typeof rawEmail !== 'string' || typeof password !== 'string') {
    throw new ServiceError('email and password must be strings', 422);
  }
  if ([rawEmail, password].some((el) => !el || !String(el).trim())) {
    logger.error('login failed some fields are missing');
    throw new ServiceError('missing fields', 422);
  }
  const email = rawEmail.trim();
  if (!EMAIL_RE.test(email)) {
    throw new ServiceError('invalid email format', 422);
  }
  if (String(password).length > MAX_PASSWORD_LENGTH) {
    throw new ServiceError('password too long', 422);
  }

  // Always perform bcrypt compare to prevent timing-based enumeration
  const account = await Collections.Account.findOne({
    email: email.toLowerCase()
  }).lean();

  const dummyHash = '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01';
  const validPassword = await bcrypt.compare(
    password,
    (account as any)?.password || dummyHash
  );
  if (!account || !validPassword) {
    logger.info(`login failed for ${redactEmail(email)}`);
    throw new ServiceError('invalid credentials', 401);
  }

  const { refreshToken, accessToken } = await _generateTokens(account as Record<string, any>);

  logger.debug(`created refresh token for ${req.hostname}`);
  res.cookie('refreshToken', refreshToken, TOKEN_COOKIE_ATTRIBUTES);
  res.json({ accessToken });
});

export default function (): Router {
  const {
    APPCREDZ_TOKEN_SECRET,
    ACCESS_TOKEN_SECRET,
    EMAILER_URL,
    RESET_TOKEN_SECRET,
    SIGNUP,
    TOKEN_COOKIE_ATTRIBUTES
  } = Service.getInstance().envConfig.getValues() as any;
  const landlordRouter = express.Router();

  landlordRouter.use(
    locale(['fr-FR', 'en-US', 'pt-BR', 'de-DE', 'es-CO', 'el'], 'en-US')
  );

  if (SIGNUP) {
    landlordRouter.post(
      '/signup',
      authRateLimit,
      Middlewares.asyncWrapper(async (req: Request, res: Response) => {
        const { firstname, lastname, email, password } = req.body;
        if (
          [firstname, lastname, email, password].some((el) => !el || !String(el).trim())
        ) {
          throw new ServiceError('missing fields', 422);
        }
        if (!EMAIL_RE.test(email.trim())) {
          throw new ServiceError('invalid email format', 422);
        }
        if (String(password).length < MIN_PASSWORD_LENGTH) {
          throw new ServiceError(
            `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
            422
          );
        }
        if (String(password).length > MAX_PASSWORD_LENGTH) {
          throw new ServiceError('password too long', 422);
        }
        const existingAccount = await Collections.Account.findOne({
          email: email.toLowerCase()
        });
        if (existingAccount) {
          return res.sendStatus(201);
        }
        await Collections.Account.create({
          firstname: firstname.trim(),
          lastname: lastname.trim(),
          email: email.trim().toLowerCase(),
          password: password
        });
        res.sendStatus(201);
      })
    );
  }

  landlordRouter.post(
    '/signin',
    authRateLimit,
    Middlewares.asyncWrapper(async (req: Request, res: Response, next) => {
      if (!req.body.email && !req.body.clientId) {
        throw new ServiceError('missing fields', 422);
      }

      if (req.body.email) {
        return await _userSignIn(req, res, next);
      }

      if (req.body.clientId) {
        return await _applicationSignIn(req, res, next);
      }
    })
  );

  landlordRouter.use(
    '/appcredz',
    Middlewares.needAccessToken(ACCESS_TOKEN_SECRET!)
  );
  landlordRouter.use('/appcredz', Middlewares.checkOrganization());
  landlordRouter.post(
    '/appcredz',
    Middlewares.asyncWrapper(async (req: Request, res: Response) => {
      if ((req as any).user.role !== 'administrator') {
        throw new ServiceError(
          'your current role does not allow to perform this action',
          403
        );
      }

      const { expiry, organizationId } = req.body;
      if (
        [expiry, organizationId].some((el) => !el || !String(el).trim())
      ) {
        logger.error('AppCredz creation failed some fields are missing');
        throw new ServiceError('missing fields', 422);
      }
      const expiryDate = new Date(expiry);

      const clientId = crypto.randomUUID();
      const clientSecret = jwt.sign(
        {
          organizationId,
          jti: clientId,
          exp: expiryDate.getTime() / 1000
        },
        APPCREDZ_TOKEN_SECRET!
      );

      res.json({ clientId, clientSecret });
    })
  );

  landlordRouter.post(
    '/refreshtoken',
    Middlewares.asyncWrapper(async (req: Request, res: Response) => {
      const oldRefreshToken = req.cookies.refreshToken;
      logger.debug('refresh token request received');
      if (!oldRefreshToken) {
        logger.debug('missing refresh token');
        throw new ServiceError('invalid credentials', 403);
      }

      const { refreshToken, accessToken } =
        await _refreshTokens(oldRefreshToken);
      if (!refreshToken) {
        res.clearCookie('refreshToken', TOKEN_COOKIE_ATTRIBUTES);
        throw new ServiceError('invalid credentials', 403);
      }

      res.cookie('refreshToken', refreshToken, TOKEN_COOKIE_ATTRIBUTES);
      res.json({ accessToken });
    })
  );

  landlordRouter.delete(
    '/signout',
    Middlewares.asyncWrapper(async (req: Request, res: Response) => {
      const refreshToken = req.cookies.refreshToken;
      logger.debug('refresh token removal requested');
      if (!refreshToken) {
        return res.sendStatus(202);
      }

      res.clearCookie('refreshToken', TOKEN_COOKIE_ATTRIBUTES);
      await _clearTokens(refreshToken);
      res.sendStatus(204);
    })
  );

  landlordRouter.post(
    '/forgotpassword',
    authRateLimit,
    Middlewares.asyncWrapper(async (req: Request, res: Response) => {
      const { email } = req.body;
      if (typeof email !== 'string') {
        throw new ServiceError('email must be a string', 422);
      }
      if (!email) {
        logger.error('missing email field');
        throw new ServiceError('missing fields', 422);
      }
      const account = await Collections.Account.findOne({
        email: email.toLowerCase()
      });
      if (account) {
        const token = jwt.sign({ email }, RESET_TOKEN_SECRET!, {
          expiresIn: '1h'
        });
        await Service.getInstance().redisClient!.set(token, email, {
          EX: 3600
        });

        // Fire-and-forget: do NOT await the emailer. Awaiting a network call
        // here makes the known-account branch ~200ms slower than the
        // unknown-account branch (~7ms), which is a textbook user-enumeration
        // timing oracle. Returning 204 immediately closes that channel.
        axios
          .post(
            `${EMAILER_URL}/resetpassword`,
            {
              templateName: 'reset_password',
              recordId: email,
              params: {
                token
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
              `failed to dispatch reset_password email for ${redactEmail(email)}: ${err?.message || err}`
            );
          });
      }
      res.sendStatus(204);
    })
  );

  landlordRouter.patch(
    '/resetpassword',
    Middlewares.asyncWrapper(async (req: Request, res: Response) => {
      const { resetToken, password } = req.body;
      if (
        [resetToken, password].some((el) => !el || !String(el).trim())
      ) {
        throw new ServiceError('missing fields', 422);
      }
      if (String(password).length < MIN_PASSWORD_LENGTH) {
        throw new ServiceError(
          `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
          422
        );
      }
      if (String(password).length > MAX_PASSWORD_LENGTH) {
        throw new ServiceError('password too long', 422);
      }

      // Verify JWT BEFORE deleting from Redis to prevent race condition
      try {
        jwt.verify(resetToken, RESET_TOKEN_SECRET!, { algorithms: ['HS256'] });
      } catch (error) {
        throw new ServiceError('invalid or expired reset token', 403);
      }

      const email = await Service.getInstance().redisClient!.get(resetToken);
      if (!email) {
        throw new ServiceError('invalid credentials', 403);
      }

      await Service.getInstance().redisClient!.del(resetToken);

      const account = await Collections.Account.findOne({
        email: email.toLowerCase()
      });
      if (!account) {
        throw new ServiceError('invalid credentials', 403);
      }
      (account as any).password = password;
      await (account as any).save();

      res.sendStatus(200);
    })
  );

  return landlordRouter;
}
