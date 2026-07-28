import { Collections, Crypto, logger } from '@microrealestate/common';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

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
      { headers: { 'Content-Type': 'application/json' }, timeout: 20_000 }
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

/**
 * Send a document (PDF) to Telegram via sendDocument with `caption` as the
 * message text. Same config/fallback contract as sendTelegram. Uses the
 * native fetch/FormData/Blob of Node 20 — multipart upload, no extra deps.
 */
export async function sendTelegramDocument(
  realmId: string,
  caption: string,
  filePath: string,
  chatId?: string
): Promise<{ messageId: number } | null> {
  const config = await getConfig(realmId);
  if (!config) {
    logger.warn('Telegram not configured, skipping document notification');
    return null;
  }
  const target = (chatId || config.adminChatId || '').trim();
  if (!target) {
    logger.warn('Telegram: no chat id (neither explicit nor adminChatId)');
    return null;
  }

  const form = new FormData();
  form.append('chat_id', target);
  // Telegram caption hard limit is 1024 chars.
  form.append('caption', caption.slice(0, 1024));
  form.append(
    'document',
    new Blob([fs.readFileSync(filePath)], { type: 'application/pdf' }),
    path.basename(filePath)
  );

  // Bound the upload — native fetch has no default timeout, so a hung Telegram
  // connection would pin this request thread forever (ingress+error-path audit
  // 2026-07). 30s covers a multi-MB PDF upload.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30_000);
  let data: any;
  let status = 0;
  try {
    const resp = await fetch(
      `https://api.telegram.org/bot${config.botToken}/sendDocument`,
      { method: 'POST', body: form, signal: ac.signal }
    );
    status = resp.status;
    // Read the body INSIDE the timeout window — a server that returns headers
    // then stalls the body would otherwise hang here unbounded (Step-7 F3).
    data = await resp.json();
  } catch (err: any) {
    const msg = ac.signal.aborted ? 'timeout after 30s' : err?.message || err;
    logger.error(`Telegram document to ${target} failed: ${msg}`);
    throw new Error(`Telegram failed: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
  if (!data?.ok) {
    const msg = data?.description || `HTTP ${status}`;
    logger.error(`Telegram document to ${target} failed: ${msg}`);
    throw new Error(`Telegram failed: ${msg}`);
  }
  logger.info(`Telegram document sent to ${target}: ${data.result?.message_id}`);
  return { messageId: data.result?.message_id };
}
