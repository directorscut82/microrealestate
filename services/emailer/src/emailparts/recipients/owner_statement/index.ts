import { Service } from '@microrealestate/common';

/**
 * Recipient resolver for owner statements: sends to the OWNER's email
 * (from units[].owners[].email via the shared statement builder), not a
 * tenant's contacts. Same from/replyTo/bcc rules as the tenant resolvers.
 */
export function get(recordId: string, params: any, data: any) {
  const ownerEmail = String(data?.owner?.email || '').trim().toLowerCase();
  if (!ownerEmail) {
    // Same phrasing family as the tenant resolver so emailmanager's
    // structural-skip detection keeps working.
    throw new Error('missing recipient list: owner has no email');
  }

  let emailDeliveryServiceConfig: any;
  if (data.landlord.thirdParties?.gmail?.selected) {
    emailDeliveryServiceConfig = data.landlord.thirdParties.gmail;
  }
  if (data.landlord.thirdParties?.smtp?.selected) {
    emailDeliveryServiceConfig = data.landlord.thirdParties.smtp;
  }
  if (data.landlord.thirdParties?.mailgun?.selected) {
    emailDeliveryServiceConfig = data.landlord.thirdParties.mailgun;
  }
  if (!emailDeliveryServiceConfig) {
    throw new Error('landlord has not configured an email delivery service');
  }

  const { PRODUCTION } = Service.getInstance().envConfig.getValues();
  const fromEmail = emailDeliveryServiceConfig.fromEmail;
  const replyToEmail = emailDeliveryServiceConfig.replyToEmail;

  let recipients: any = {
    from: fromEmail,
    to: ownerEmail,
    replyTo: replyToEmail
  };
  if (PRODUCTION && data.landlord.members?.length) {
    recipients = {
      ...recipients,
      bcc: data.landlord.members
        .filter(
          ({ email, registered }: { email: string; registered: boolean }) =>
            registered && email !== fromEmail
        )
        .map(({ email }: { email: string }) => email)
        .join(',')
    };
  }
  return [recipients];
}
