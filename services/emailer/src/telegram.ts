import { Collections, Crypto, logger } from '@microrealestate/common';
import axios from 'axios';

interface TelegramConfig {
  botToken: string;
  adminChatId: string;
}

async function getConfig(realmId: string): Promise<TelegramConfig | null> {
  const realm = await Collections.Realm.findOne({ _id: realmId }).lean();
  const tg = (realm as any)?.thirdParties?.telegram;
  if (!tg?.selected || !tg?.botToken) {
    return null;
  }
  return {
    botToken: Crypto.decrypt(tg.botToken),
    adminChatId: tg.adminChatId || ''
  };
}

/**
 * Send a Telegram message. When `chatId` is omitted it falls back to the
 * realm's configured adminChatId (self/admin notifications). Returns null
 * when Telegram is not configured for the realm so callers can degrade
 * gracefully (same contract as sendSms).
 */
export async function sendTelegram(
  realmId: string,
  text: string,
  chatId?: string
): Promise<{ messageId: number } | null> {
  const config = await getConfig(realmId);
  if (!config) {
    logger.warn('Telegram not configured, skipping notification');
    return null;
  }
  const target = (chatId || config.adminChatId || '').trim();
  if (!target) {
    logger.warn('Telegram: no chat id (neither explicit nor adminChatId)');
    return null;
  }

  try {
    const response = await axios.post(
      `https://api.telegram.org/bot${config.botToken}/sendMessage`,
      { chat_id: target, text, disable_web_page_preview: true },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const messageId = response.data?.result?.message_id;
    logger.info(`Telegram sent to ${target}: ${messageId}`);
    return { messageId };
  } catch (error: any) {
    // Telegram returns a descriptive `description` on the error body.
    const msg =
      error.response?.data?.description || error.response?.data?.message || error.message;
    logger.error(`Telegram to ${target} failed: ${msg}`);
    throw new Error(`Telegram failed: ${msg}`);
  }
}
