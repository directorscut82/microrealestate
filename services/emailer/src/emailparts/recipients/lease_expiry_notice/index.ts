import { Collections, logger, Service } from '@microrealestate/common';

/**
 * Recipient resolver for lease_expiry_notice.
 *
 * Unlike the rentcall family this email is for the *landlord*, not the
 * tenant. Recipients are:
 *   - To: realm.members[].email where registered === true
 *   - BCC: building.manager.email when the tenant's first property has a
 *          buildingId and that building has a manager email configured
 *
 * From / replyTo come from the realm's selected email-delivery service —
 * matching the recipients/invoice fall-through so the same provider is
 * used for transactional landlord email.
 */
export async function get(_recordId: string, _params: any, data: any) {
  if (!data?.landlord) {
    throw new Error('landlord context missing for lease_expiry_notice');
  }

  const emailDeliveryServiceConfig = _resolveDeliveryConfig(data.landlord);
  if (!emailDeliveryServiceConfig) {
    throw new Error('landlord has not configured an email delivery service');
  }

  const fromEmail = emailDeliveryServiceConfig.fromEmail;
  const replyToEmail = emailDeliveryServiceConfig.replyToEmail;

  const members: any[] = Array.isArray(data.landlord.members)
    ? data.landlord.members
    : [];
  const toEmails = members
    .filter(
      (m) =>
        m &&
        m.registered &&
        typeof m.email === 'string' &&
        m.email.trim().length > 0
    )
    .map((m) => m.email.toLowerCase());

  if (!toEmails.length) {
    throw new Error(
      'no registered realm members for lease_expiry_notice'
    );
  }

  const bccEmail = await _resolveManagerBcc(data, fromEmail);

  const { PRODUCTION } = Service.getInstance().envConfig.getValues();
  const dedupedTo = Array.from(new Set(toEmails));

  const recipientsList = dedupedTo.map((to) => {
    const payload: Record<string, any> = {
      from: fromEmail,
      to,
      replyTo: replyToEmail
    };
    // BCC the building manager when present; only honoured in production
    // to match the recipients/invoice convention (avoids dev sends to a
    // real manager mailbox during local tests).
    if (PRODUCTION && bccEmail && bccEmail !== to && bccEmail !== fromEmail) {
      payload.bcc = bccEmail;
    }
    return payload;
  });

  return recipientsList;
}

function _resolveDeliveryConfig(landlord: any): any | null {
  if (landlord.thirdParties?.gmail?.selected) {
    return landlord.thirdParties.gmail;
  }
  if (landlord.thirdParties?.smtp?.selected) {
    return landlord.thirdParties.smtp;
  }
  if (landlord.thirdParties?.mailgun?.selected) {
    return landlord.thirdParties.mailgun;
  }
  return null;
}

async function _resolveManagerBcc(
  data: any,
  fromEmail: string
): Promise<string | null> {
  try {
    const properties = data?.tenant?.contract?.properties || [];
    const first = properties[0];
    const buildingId = first?.buildingId;
    if (!buildingId) return null;
    const building = await (Collections as any).Building.findOne({
      _id: buildingId,
      realmId: data.landlord._id
    }).lean();
    const managerEmail = building?.manager?.email;
    if (
      managerEmail &&
      typeof managerEmail === 'string' &&
      managerEmail.toLowerCase() !== String(fromEmail || '').toLowerCase()
    ) {
      return managerEmail.toLowerCase();
    }
  } catch (err) {
    logger.warn(
      `lease_expiry_notice: failed to resolve building manager bcc: ${err}`
    );
  }
  return null;
}
