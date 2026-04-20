import * as Emailer from './emailer.js';
import { sendSms } from './sms.js';
import {
  logger,
  Middlewares,
  Service,
  ServiceError
} from '@microrealestate/common';
import express from 'express';
import locale from 'locale';
import type { Request, Response } from 'express';

async function _send(req: Request, res: Response): Promise<void> {
  const { templateName, recordId, params } = req.body;
  let allowedTemplates: string[];
  switch (req.path) {
    case '/emailer/resetpassword':
      allowedTemplates = ['reset_password'];
      break;
    case '/emailer/otp':
      allowedTemplates = ['otp'];
      break;
    default:
      allowedTemplates = [
        'invoice',
        'rentcall',
        'rentcall_last_reminder',
        'rentcall_reminder'
      ];
      break;
  }
  if (!allowedTemplates.includes(templateName)) {
    logger.warn(`template not found ${templateName}`);
    throw new ServiceError('template not found', 404);
  }

  const results = await Emailer.send(
    req.headers.authorization,
    (req as any).realm?.locale || (req as any).rawLocale.code,
    (req as any).realm?.currency || '',
    (req as any).realm?._id || req.headers.organizationid,
    templateName,
    recordId,
    params
  );

  if (!results || !results.length) {
    throw new ServiceError(
      `no results returned by the email engine after sending the email ${templateName}`,
      500
    );
  }

  res.json(results);
}

export default function routes(): express.Router {
  const { ACCESS_TOKEN_SECRET } = Service.getInstance().envConfig.getValues();
  const apiRouter = express.Router();
  apiRouter.use(locale(['fr-FR', 'en', 'pt-BR', 'de-DE', 'es-CO', 'el'], 'en'));
  apiRouter.post('/emailer/resetpassword', Middlewares.asyncWrapper(_send));
  apiRouter.post('/emailer/otp', Middlewares.asyncWrapper(_send));
  apiRouter.use(
    Middlewares.needAccessToken(ACCESS_TOKEN_SECRET as string),
    Middlewares.checkOrganization(),
    Middlewares.notRoles(['tenant'])
  );

  apiRouter.get(
    '/emailer/status/:startTerm/:endTerm?',
    Middlewares.asyncWrapper(async (req: Request, res: Response) => {
      const { startTerm, endTerm } = req.params;
      const result = await Emailer.status(
        null,
        Number(startTerm),
        endTerm ? Number(endTerm) : null
      );
      res.json(result);
    })
  );

  apiRouter.post('/emailer', Middlewares.asyncWrapper(_send));

  apiRouter.post(
    '/emailer/sms',
    Middlewares.asyncWrapper(async (req: Request, res: Response) => {
      const { phoneNumber, text } = req.body;
      if (!phoneNumber || !text) {
        throw new ServiceError('phoneNumber and text are required', 422);
      }
      const realmId = String((req as any).realm?._id || req.headers.organizationid);
      const result = await sendSms(realmId, phoneNumber, text);
      if (!result) {
        throw new ServiceError('SMS gateway not configured', 503);
      }
      res.json(result);
    })
  );

  return apiRouter;
}
