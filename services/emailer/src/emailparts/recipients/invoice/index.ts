import { logger, Service } from '@microrealestate/common';

export function get(recordId: string, params: any, data: any) {
  if (!data.tenant || !data.tenant.contacts) {
    throw new Error('tenant has not any contact emails');
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

  logger.debug(`email config fromEmail: ${emailDeliveryServiceConfig.fromEmail}, contacts: ${JSON.stringify(data.tenant.contacts.map((c: any) => c.email))}`);

  const { PRODUCTION } = Service.getInstance().envConfig.getValues();
  const fromEmail = emailDeliveryServiceConfig.fromEmail;
  const replyToEmail = emailDeliveryServiceConfig.replyToEmail;

  const recipientsList = data.tenant.contacts
    .filter((contact: any) => contact.email)
    .reduce((acc: any[], { email }: { email: string }) => {
      if (acc.find(({ to }: { to: string }) => to === email.toLowerCase())) {
        return acc;
      }
      let recipients: any = {
        from: fromEmail,
        to: email.toLowerCase(),
        replyTo: replyToEmail
      };
      if (PRODUCTION && data.landlord.members.length) {
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
      acc.push(recipients);
      return acc;
    }, []);

  if (!recipientsList || !recipientsList.length) {
    throw new Error('tenant has not any contact emails');
  }

  return recipientsList;
}
