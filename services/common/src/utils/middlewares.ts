import * as Express from 'express';
import * as JWT from 'jsonwebtoken';
import {
  ApplicationServicePrincipal,
  CollectionTypes,
  ConnectionRole,
  ConnectionType,
  InternalServicePrincipal,
  MongooseDocument,
  ServiceRequest,
  ServiceResponse,
  UserServicePrincipal
} from '@microrealestate/types';
import logger from './logger.js';
import Realm from '../collections/realm.js';
import ServiceError from './serviceerror.js';

type ErrorBodyType = {
  status: number;
  message: string;
  stack?: string;
};

interface AsyncRequestHandler {
  (
    req: Express.Request,
    res: Express.Response,
    next: Express.NextFunction
  ): Promise<void | never | Express.Response>;
}

export function asyncWrapper(cb: AsyncRequestHandler): Express.Handler {
  return (req, res, next) => cb(req, res, next).catch(next);
}

export function errorHandler(
  error: ServiceError | Error,
  req: Express.Request,
  res: Express.Response<ErrorBodyType>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: Express.NextFunction
) {
  const responseBody: ErrorBodyType = {
    status: error instanceof ServiceError ? error.statusCode || 500 : 500,
    message: error.message
  };

  if (process.env.NODE_ENV !== 'production') {
    responseBody.stack = error.stack;
  }

  // Pass the error object so winston captures the stack and metadata
  // instead of a flat `[object Object]` / coerced string.
  logger.error(error);
  res.status(responseBody.status).json(responseBody);
}

export function needAccessToken(
  accessTokenSecret: string | undefined
): (
  req: Express.Request,
  res: Express.Response,
  next: Express.NextFunction
) => void {
  return (
    request: Express.Request,
    res: Express.Response,
    next: Express.NextFunction
  ) => {
    const req = request as ServiceRequest;
    if (!accessTokenSecret) {
      logger.error('accessTokenSecret not set');
      return res.sendStatus(401);
    }

    let accessToken;
    // landlord api sends accessToken in the authorization header
    if (req.headers.authorization) {
      accessToken = req.headers.authorization.split(' ')[1];
    }

    // tenant api sends accessToken in the sessionToken cookie
    if (!req.headers.authorization && req.cookies && req.cookies.sessionToken) {
      accessToken = req.cookies.sessionToken;
    }

    if (!accessToken) {
      logger.warn('accessToken not passed in the request');
      return res.sendStatus(401);
    }

    try {
      const decoded = JWT.verify(
        accessToken,
        accessTokenSecret,
        { algorithms: ['HS256'] }
      ) as JWT.JwtPayload;
      if (decoded.account) {
        const user: UserServicePrincipal = {
          type: 'user',
          email: decoded.account.email,
          role: decoded.account.role
        };
        req.user = user;
      } else if (decoded.application) {
        const user: ApplicationServicePrincipal = {
          type: 'application',
          clientId: decoded.application.clientId
        };
        req.user = user;
      } else if (decoded.service) {
        const user: InternalServicePrincipal = {
          type: 'service',
          serviceId: decoded.service.serviceId,
          realmId: decoded.service.realmId,
          role: decoded.service.role
        };
        req.user = user;
      } else {
        logger.warn('accessToken is invalid');
        return res.sendStatus(401);
      }
    } catch (error) {
      logger.warn('jwt verification failed', {
        error: (error as Error)?.message,
        name: (error as Error)?.name
      });
      return res.sendStatus(401);
    }

    next();
  };
}

export function checkOrganization() {
  return async (
    request: Express.Request,
    response: Express.Response,
    next: Express.NextFunction
  ) => {
    const req = request as ServiceRequest;
    const res = response as ServiceResponse;

    // skip organization checks when request comes from tenantapi with sessionToken cookie
    if (!req.headers.authorization && req.cookies.sessionToken) {
      // Best-effort: if the session token (or organizationid header)
      // carries an organizationId, resolve req.realm so downstream code
      // doesn't crash dereferencing req.realm. We deliberately do NOT
      // jwt-verify here — the auth middleware already validated the token
      // against ACCESS_TOKEN_SECRET; we only peek at unverified claims to
      // pull the realmId. If nothing is available we fall through to next()
      // preserving the previous behavior.
      try {
        let orgIdCandidate: string | undefined;

        const sessionToken = req.cookies.sessionToken;
        if (typeof sessionToken === 'string') {
          const decoded = JWT.decode(sessionToken) as JWT.JwtPayload | null;
          if (decoded) {
            if (typeof decoded.organizationId === 'string') {
              orgIdCandidate = decoded.organizationId;
            } else if (
              decoded.account &&
              typeof (decoded.account as any).organizationId === 'string'
            ) {
              orgIdCandidate = (decoded.account as any).organizationId;
            }
          }
        }

        if (
          !orgIdCandidate &&
          typeof req.headers.organizationid === 'string'
        ) {
          orgIdCandidate = req.headers.organizationid;
        }

        if (
          orgIdCandidate &&
          /^[a-f0-9]{24}$/i.test(orgIdCandidate)
        ) {
          const realmDoc = (
            await Realm.findOne<MongooseDocument<CollectionTypes.Realm>>({
              _id: orgIdCandidate
            })
          )?.toObject();
          if (realmDoc) {
            realmDoc._id = String(realmDoc._id);
            req.realm = realmDoc;
          }
        }
      } catch (err) {
        logger.warn('failed to resolve realm for sessionToken request', {
          error: (err as Error)?.message
        });
      }
      return next();
    }

    switch (req.user.type) {
      case 'user':
        // for the current user, add all subscribed organizations in request object
        req.realms = (
          await Realm.find<MongooseDocument<CollectionTypes.Realm>>({
            members: { $elemMatch: { email: req.user.email } }
          })
        )
          .map((realm) => realm.toObject())
          .map((realm) => {
            realm._id = String(realm._id);
            return realm;
          });
        break;
      case 'application': {
        // for the current application access, add only the associated realm
        const realm = (
          await Realm.findOne<MongooseDocument<CollectionTypes.Realm>>({
            applications: { $elemMatch: { clientId: req.user.clientId } }
          })
        )?.toObject();
        if (realm) {
          realm._id = String(realm._id);
          req.realms = [realm];
        } else {
          req.realms = [];
        }
        break;
      }
      case 'service': {
        // for the current service access, add only the associated realm
        const realm = (
          await Realm.findOne<MongooseDocument<CollectionTypes.Realm>>({
            _id: req.user.realmId
          })
        )?.toObject();
        if (realm) {
          realm._id = String(realm._id);
          req.realms = [realm];
        } else {
          req.realms = [];
        }
        break;
      }
      default:
        logger.error(
          'checkOrganization: Invalid request received: neither user nor application'
        );
        return res.sendStatus(500);
    }

    // skip organization checks when fetching them
    if (req.path === '/realms') {
      return next();
    }

    // For other requests

    // check if organizationid header exists
    const organizationId = req.headers.organizationid;
    if (!organizationId) {
      logger.warn('organizationId not passed in request');
      return res.sendStatus(404);
    }
    // Validate organizationId format (must be a valid MongoDB ObjectId)
    if (typeof organizationId !== 'string' || !/^[a-f0-9]{24}$/i.test(organizationId)) {
      logger.warn('invalid organizationId format in request');
      return res.sendStatus(404);
    }

    // add organization in request object
    req.realm = (
      await Realm.findOne<MongooseDocument<CollectionTypes.Realm>>({
        _id: organizationId
      })
    )?.toObject();

    if (!req.realm) {
      // send 404 if req.realm is not set
      logger.warn('impossible to set organizationId in request');
      return res.sendStatus(404);
    }

    req.realm._id = String(req.realm._id);

    // current user is not a member of the organization
    if (!req.realms.find(({ _id }) => _id === req.realm?._id)) {
      logger.warn('current user is not a member of the organization');
      return res.sendStatus(404);
    }

    // resolve the role for the current realm
    switch (req.user.type) {
      case 'user': {
        const user = req.user as UserServicePrincipal;
        user.role = req.realm.members.find(
          ({ email }) => email === user.email
        )?.role;
        break;
      }
      case 'application':
        req.user.role = req.realm.applications.find(
          ({ clientId }) =>
            clientId === (req.user as ApplicationServicePrincipal).clientId
        )?.role;
        break;
    }
    if (!req.user.role) {
      logger.warn('current user could no be found within realm');
      return res.sendStatus(404);
    }

    next();
  };
}

export function onlyRoles(roles: [ConnectionRole, ...ConnectionRole[]]) {
  return (
    request: Express.Request,
    response: Express.Response,
    next: Express.NextFunction
  ) => {
    const req = request as ServiceRequest;
    const res = response as ServiceResponse;

    if (!req.user) {
      logger.warn('user not set in request');
      return res.sendStatus(401);
    }

    if (!req.user.role) {
      logger.warn('role not set in user');
      return res.sendStatus(401);
    }

    if (!roles.includes(req.user.role)) {
      logger.warn('user does not have required role');
      return res.sendStatus(403);
    }

    next();
  };
}

export function notRoles(roles: [ConnectionRole, ...ConnectionRole[]]) {
  return (
    request: Express.Request,
    response: Express.Response,
    next: Express.NextFunction
  ) => {
    const req = request as ServiceRequest;
    const res = response as ServiceResponse;
    if (!req.user) {
      logger.warn('user not set in request');
      return res.sendStatus(401);
    }

    if (!req.user.role) {
      return next();
    }

    if (roles.includes(req.user.role)) {
      logger.warn('user has forbidden role');
      return res.sendStatus(403);
    }

    next();
  };
}

export function onlyTypes(types: [ConnectionType, ...ConnectionType[]]) {
  return (
    request: Express.Request,
    response: Express.Response,
    next: Express.NextFunction
  ) => {
    const req = request as ServiceRequest;
    const res = response as ServiceResponse;

    if (!req.user) {
      logger.warn('user not set in request');
      return res.sendStatus(401);
    }

    if (!req.user.type) {
      logger.warn('type not set in user');
      return res.sendStatus(401);
    }

    if (!types.includes(req.user.type)) {
      logger.warn('user does not have required type');
      return res.sendStatus(403);
    }

    next();
  };
}
