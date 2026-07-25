/**
 * Bill B2 archival — Slice 5 (§8 of the bill-OCR plan, DECISION A: api uploads
 * to B2 directly).
 *
 * Mirrors services/pdfgenerator/src/utils/s3.ts (_initS3 + isEnabled) but
 * uploads a Buffer body via putObject — api holds bill bytes in memory (multer
 * buffer / Telegram download), so there is no disk path to stream. AWS SDK v2
 * putObject accepts a Buffer Body directly, so no temp file is needed.
 *
 * KEY CONVENTION — critical: the object key MUST start with
 *   `${sanitize(realm.name)}-${sanitize(realmId)}/`
 * because the ONLY thing that serves these bytes back is pdfgenerator's
 * `GET /api/v2/documents/by-key`, which 403s any key not under that prefix
 * (documents.ts:639). Bill artifacts go under `<prefix>/bills/<billId>/<file>`.
 *
 * B2 is gated by s3.isEnabled (all 4 fields present) — NOTE the realm b2 config
 * has NO `selected` flag (unlike telegram/sms); presence of the creds IS the
 * gate. When B2 is not configured, callers keep the inline data-URI behavior.
 */
import { Crypto, logger } from '@microrealestate/common';
import AWS from 'aws-sdk';
import sfn from 'sanitize-filename';

// MUST match pdfgenerator's sanitize() EXACTLY (services/pdfgenerator/src/
// utils/index.ts) — it uses { replacement: '_' }. The by-key download route
// rebuilds the expected prefix with the SAME function and 403s any key that
// doesn't match, so a divergent sanitizer here (e.g. the default '' replacement)
// would produce an unretrievable object for any realm whose name/id contains an
// illegal filename char (`/`, `:`, `*`, reserved names like `con`, …).
function sanitize(name = ''): string {
  return sfn(name, { replacement: '_' });
}

export interface B2Config {
  keyId: string;
  applicationKey: string;
  endpoint: string;
  bucket: string;
}

/** True when all four B2 fields are present (same contract as pdfgenerator). */
export function isEnabled(
  b2Config: Partial<B2Config> | undefined | null
): boolean {
  return !!(
    b2Config?.keyId &&
    b2Config?.applicationKey &&
    b2Config?.endpoint &&
    b2Config?.bucket
  );
}

function _initS3(b2Config: B2Config): AWS.S3 {
  const credentials = new AWS.Credentials(
    Crypto.decrypt(b2Config.keyId),
    Crypto.decrypt(b2Config.applicationKey)
  );
  const ep = new AWS.Endpoint(b2Config.endpoint);
  // Pass creds per-client (not via the global AWS.config mutation
  // pdfgenerator's helper uses) so concurrent uploads for different realms
  // never race a shared global credential object.
  return new AWS.S3({ endpoint: ep, credentials });
}

/**
 * Build the realm-scoped object key for a bill artifact. Matches the prefix
 * pdfgenerator's by-key download route enforces, so the file is retrievable.
 */
export function billObjectKey(
  realmName: string,
  realmId: string,
  billId: string,
  fileName: string
): string {
  const prefix = `${sanitize(realmName)}-${sanitize(realmId)}`;
  return `${prefix}/bills/${sanitize(billId)}/${sanitize(fileName)}`;
}

/**
 * Upload a Buffer to B2 under `key`. Returns the key + versionId. Throws on
 * failure — callers decide whether a storage failure is fatal (it is NOT for
 * bill archival: the Bill doc must persist regardless, see confirmBills).
 */
export async function uploadBuffer(
  b2Config: B2Config,
  key: string,
  body: Buffer,
  contentType?: string
): Promise<{ key: string; versionId?: string }> {
  const s3 = _initS3(b2Config);
  return new Promise((resolve, reject) => {
    s3.putObject(
      {
        Bucket: b2Config.bucket,
        Key: key,
        Body: body,
        ...(contentType ? { ContentType: contentType } : {})
      },
      (err, data) => {
        if (err) {
          logger.error(`bill B2 upload ${key} failed: ${err.message}`);
          return reject(err);
        }
        resolve({ key, versionId: data.VersionId });
      }
    );
  });
}
