import * as Emailer from './emailer.js';
import { sendSms } from './sms.js';
import { sendTelegram, sendTelegramDocument } from './telegram.js';
import fetchPDF from './emailparts/attachments/fetchpdf.js';
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
        'rentcall_reminder',
        'lease_expiry_notice'
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
      // Realm-scope the lookup. Without this the status query returned
      // every realm's audit rows that matched startTerm/endTerm.
      const realmId = String(
        (req as any).realm?._id || req.headers.organizationid || ''
      );
      if (!realmId) {
        throw new ServiceError('organizationId required', 422);
      }
      const result = await Emailer.status(
        realmId,
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

  apiRouter.post(
    '/emailer/telegram',
    Middlewares.asyncWrapper(async (req: Request, res: Response) => {
      const { text, chatId, attachment } = req.body;
      if (!text) {
        throw new ServiceError('text is required', 422);
      }
      const realmId = String((req as any).realm?._id || req.headers.organizationid);
      // Optional PDF attachment: { templateName, recordId, term } — fetch the
      // same rendered PDF the email attaches (reuses fetchpdf) and deliver it
      // as a Telegram document with `text` as the caption.
      if (attachment?.templateName && attachment?.recordId && attachment?.term) {
        const filename = `${String(attachment.templateName)}-${String(
          attachment.recordId
        )}-${String(attachment.term)}.pdf`.replace(/[^A-Za-z0-9._-]/g, '_');
        const filePath = await fetchPDF(
          req.headers.authorization,
          realmId,
          String(attachment.templateName),
          String(attachment.recordId),
          { term: attachment.term },
          filename
        );
        const result = await sendTelegramDocument(realmId, text, filePath, chatId);
        if (!result) {
          throw new ServiceError('Telegram not configured', 503);
        }
        return res.json(result);
      }
      const result = await sendTelegram(realmId, text, chatId);
      if (!result) {
        throw new ServiceError('Telegram not configured', 503);
      }
      res.json(result);
    })
  );

  return apiRouter;
}
