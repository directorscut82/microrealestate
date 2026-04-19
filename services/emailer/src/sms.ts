import { Collections, Crypto, logger } from '@microrealestate/common';
import axios from 'axios';

interface SmsConfig {
  url: string;
  username: string;
  password: string;
}

async function getConfig(realmId: string): Promise<SmsConfig | null> {
  const realm = await Collections.Realm.findOne({ _id: realmId }).lean();
  const sms = (realm as any)?.thirdParties?.smsGateway;
  if (!sms?.selected || !sms?.url || !sms?.username || !sms?.password) {
    return null;
  }
  return { url: sms.url, username: sms.username, password: Crypto.decrypt(sms.password) };
}

export async function sendSms(
  realmId: string,
  phoneNumber: string,
  text: string
): Promise<{ id: string; state: string } | null> {
  const config = await getConfig(realmId);
  if (!config) {
    logger.warn('SMS gateway not configured, skipping SMS');
    return null;
  }

  // Ensure E.164 format
  let normalized = phoneNumber.replace(/[\s\-()]/g, '');
  if (!normalized.startsWith('+')) {
    normalized = '+30' + normalized;
  }

  try {
    const response = await axios.post(
      `${config.url}/3rdparty/v1/messages`,
      {
        textMessage: { text },
        phoneNumbers: [normalized],
        ttl: 3600
      },
      {
        auth: { username: config.username, password: config.password },
        headers: { 'Content-Type': 'application/json' }
      }
    );
    logger.info(`SMS sent to ${normalized}: ${response.data.id}`);
    return { id: response.data.id, state: response.data.state };
  } catch (error: any) {
    const msg = error.response?.data?.message || error.message;
    logger.error(`SMS to ${normalized} failed: ${msg}`);
    throw new Error(`SMS failed: ${msg}`);
  }
}
