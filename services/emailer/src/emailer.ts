import * as EmailAttachments from './emailattachments.js';
import * as EmailContent from './emailcontent.js';
import * as EmailData from './emaildata.js';
import * as EmailEngine from './emailengine.js';
import * as EmailRecipients from './emailrecipients.js';
import {
  Collections,
  logger,
  Service,
  ServiceError
} from '@microrealestate/common';

export async function status(
  realmId: string,
  recordId: string | null,
  startTerm: number,
  endTerm: number | null
) {
  // Multi-tenant guard: every status query MUST be realm-scoped, otherwise
  // a caller in org A can read the email audit trail of org B by looking
  // up a recordId (e.g. tenant id or term) that happens to collide.
  if (!realmId) {
    throw new ServiceError('realmId required', 422);
  }
  const query: Record<string, any> = { realmId };
  if (recordId) {
    query.recordId = recordId;
  }
  if (startTerm && endTerm) {
    query.$and = [
      { 'params.term': { $gte: startTerm } },
      { 'params.term': { $lte: endTerm } }
    ];
  } else if (startTerm) {
    query.params = {
      term: startTerm
    };
  }

  return await Collections.Email.find(
    query,
    {
      _id: false,
      templateName: true,
      recordId: true,
      params: true,
      sentTo: true,
      sentDate: true
    },
    { sort: { sentDate: -1 } }
  ).lean();
}

export async function send(
  authorizationHeader: string | undefined,
  locale: string,
  currency: string,
  organizationId: string,
  templateName: string,
  recordId: string,
  params: Record<string, any>
) {
  const { ALLOW_SENDING_EMAILS } = Service.getInstance().envConfig.getValues();
  const result = {
    templateName,
    recordId,
    params
  };

  let data: any;
  try {
    logger.debug('fetch email data');
    data = await EmailData.build(templateName, recordId, params);
  } catch (error) {
    logger.error('error getting email data:', error);
    throw new ServiceError(
      `no data found for ${templateName} recordId: ${recordId}`,
      404
    );
  }
  logger.debug(data);

  let recipientsList: any[];
  if (ALLOW_SENDING_EMAILS) {
    try {
      logger.debug('get email recipients');
      recipientsList = await EmailRecipients.build(
        locale,
        templateName,
        recordId,
        params,
        data
      );
    } catch (error) {
      logger.error(`error getting recipients for ${templateName}:`, (error as Error).message);
      throw new ServiceError(`missing recipients for ${templateName}: ${(error as Error).message}`, 422);
    }


    if (!recipientsList?.length) {
      throw new ServiceError(`missing recipient list for ${templateName}`, 422);
    }

    if (recipientsList.some((r) => !r.to)) {
      throw new ServiceError(
        `missing recipient email for ${templateName}`,
        422
      );
    }
    logger.debug(recipientsList);
  } else {
    recipientsList = [{ to: 'test@example.com' }];
  }

  let attachments: any;
  try {
    logger.debug('add email attachments');
    attachments = await EmailAttachments.build(
      authorizationHeader,
      locale,
      organizationId,
      templateName,
      recordId,
      params,
      data
    );
  } catch (error) {
    logger.error('error getting attachments:', error);
    throw new ServiceError(`attachment not found ${templateName}`, 404);
  }

  let content: any;
  try {
    logger.debug('get email content');
    content = await EmailContent.build(
      locale,
      currency,
      templateName,
      recordId,
      params,
      data
    );
  } catch (error) {
    logger.error('error getting content:', error);
    throw new ServiceError(`missing content for ${templateName}`, 422);
  }

  // Use allSettled so a single bad recipient doesn't sink the whole batch.
  // Each entry surfaces per-recipient success or failure, with the same
  // shape callers used to receive on success.
  const settled = await Promise.allSettled(
    recipientsList.map(async (recipients) => {
      const email = {
        ...recipients,
        ...content,
        ...attachments
      };
      logger.debug(`recipients:
${email.to}
subject:
${email.subject}
text:
${email.text}
html:
${email.html}
attachments:
${email.attachment
  .map((a: any) => `${a.filename} size: ${a.data?.length || 0}`)
  .join('\n')}`);

      let status: any;
      if (ALLOW_SENDING_EMAILS) {
        status = await EmailEngine.sendEmail(email, data);
        // Persist the audit trail before returning so callers see a
        // consistent state on success. realmId is now required by the
        // Email schema. Resolve it in priority order:
        //   1. organizationId from the route caller (the normal case for
        //      invoice / rentcall flows that go through checkOrganization)
        //   2. data.landlord._id (otp flow — derived from the tenant's
        //      realm in emailparts/data/otp)
        // If neither is available (e.g. reset_password is a system-level
        // email with no realm context), skip audit persistence — the
        // audit row is realm-scoped by design and a global "no realm"
        // bucket would break the multi-tenant query model.
        const auditRealmId =
          organizationId || (data && data.landlord && data.landlord._id);
        if (auditRealmId) {
          await new Collections.Email({
            realmId: auditRealmId,
            templateName,
            recordId,
            params,
            sentTo: recipients.to,
            sentDate: new Date(),
            emailId: status.id,
            status: 'queued'
          }).save();
        } else {
          logger.debug(
            `skipping email audit row for ${templateName} (no realm context)`
          );
        }
        logger.info(`${templateName} sent to ${recordId} at ${recipients.to}`);
      } else {
        const message = `ALLOW_SENDING_EMAILS set to "false", ${templateName} not sent to ${recordId} at ${recipients.to}`;
        status = {
          id: '<devid>',
          to: email.to,
          message
        };
        logger.warn(message);
      }
      logger.debug(status);

      return {
        ...result,
        email: recipients.to,
        status
      };
    })
  );

  return settled.map((outcome, index) => {
    const recipientEmail = recipientsList[index]?.to;
    if (outcome.status === 'fulfilled') {
      return outcome.value;
    }
    const reason: any = outcome.reason;
    logger.error(
      `failed to send ${templateName} to ${recipientEmail}: ${reason?.message || reason}`
    );
    return {
      ...result,
      email: recipientEmail,
      status: {
        id: null,
        to: recipientEmail,
        error: reason?.message || String(reason)
      }
    };
  });
}
