import * as crypto from 'crypto';
import { EnvironmentValues } from '@microrealestate/types';
import Service from './service.js';

// AES-256-GCM with a fresh random IV per encryption.
// Output layout (hex string):
//   iv (12 bytes / 24 hex)  ||  authTag (16 bytes / 32 hex)  ||  ciphertext (hex)
//
// NOTE: NO BACKWARD COMPATIBILITY. Old AES-256-CBC ciphertexts produced by the
// previous deterministic-IV implementation will not decrypt under this code —
// rotate stored secrets (or wipe the DB) when shipping this change.

const IV_LENGTH = 12; // 96 bits is the GCM-recommended IV length.
const AUTH_TAG_LENGTH = 16; // 128 bits.

function _getKey(config: EnvironmentValues): Buffer {
  const key = config.CIPHER_KEY;
  if (!key) {
    throw new Error('CIPHER_KEY is not set');
  }
  // Derive a 32-byte (256-bit) key deterministically from the configured
  // secret. CIPHER_IV_KEY is no longer used for IV derivation but is left in
  // the env schema for now to avoid coupling this change to a config rename.
  return crypto.createHash('sha256').update(String(key)).digest();
}

export function encrypt(text: string): string {
  const config = Service.getInstance()?.envConfig.getValues() || {};
  const key = _getKey(config);

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(text, 'utf8'),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();

  return (
    iv.toString('hex') + authTag.toString('hex') + ciphertext.toString('hex')
  );
}

export function decrypt(encryptedText: string): string {
  const config = Service.getInstance()?.envConfig.getValues() || {};
  const key = _getKey(config);

  const ivHexLen = IV_LENGTH * 2;
  const tagHexLen = AUTH_TAG_LENGTH * 2;
  if (
    typeof encryptedText !== 'string' ||
    encryptedText.length < ivHexLen + tagHexLen
  ) {
    throw new Error('encrypted payload is malformed');
  }

  const iv = Buffer.from(encryptedText.slice(0, ivHexLen), 'hex');
  const authTag = Buffer.from(
    encryptedText.slice(ivHexLen, ivHexLen + tagHexLen),
    'hex'
  );
  const ciphertext = Buffer.from(
    encryptedText.slice(ivHexLen + tagHexLen),
    'hex'
  );

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]);
  return plaintext.toString('utf8');
}
