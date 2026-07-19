import { Crypto, logger } from '@microrealestate/common';
import AWS from 'aws-sdk';
import fs from 'fs-extra';

interface B2Config {
  keyId: string;
  applicationKey: string;
  endpoint: string;
  bucket: string;
}

function _initS3(b2Config: B2Config): AWS.S3 {
  const credentials = new AWS.Credentials(
    Crypto.decrypt(b2Config.keyId),
    Crypto.decrypt(b2Config.applicationKey)
  );
  AWS.config.credentials = credentials;
  const ep = new AWS.Endpoint(b2Config.endpoint);
  return new AWS.S3({ endpoint: ep });
}

export function isEnabled(b2Config: Partial<B2Config> | undefined | null): boolean {
  return !!(
    b2Config?.keyId &&
    b2Config?.applicationKey &&
    b2Config?.endpoint &&
    b2Config?.bucket
  );
}

export function downloadFile(b2Config: B2Config, url: string) {
  logger.debug(`download ${url} from s3`);
  const s3 = _initS3(b2Config);
  return s3
    .getObject({
      Bucket: b2Config.bucket,
      Key: url
    })
    .createReadStream();
}

export function uploadFile(
  b2Config: B2Config,
  { file, fileName, url }: { file: { path: string }; fileName: string; url: string }
) {
  logger.debug(`upload ${url} to s3`);
  return new Promise<{ fileName: string; key: string; versionId?: string }>(
    (resolve, reject) => {
      try {
        const s3 = _initS3(b2Config);
        const fileStream = fs.createReadStream(file.path);
        s3.putObject(
          {
            Bucket: b2Config.bucket,
            Key: url,
            Body: fileStream
          },
          (err, data) => {
            if (err) {
              return reject(err);
            }
            resolve({
              fileName,
              key: url,
              versionId: data.VersionId
            });
          }
        );
      } catch (error) {
        reject(error);
      }
    }
  );
}

/**
 * List every live object key under a prefix (paginated; delete markers and
 * old versions excluded — this is "what exists now"). Used by the
 * storage-reconcile pass to diff B2 contents against Document records.
 */
export async function listKeys(
  b2Config: B2Config,
  prefix: string
): Promise<string[]> {
  const objs = await listObjects(b2Config, prefix);
  return objs.map((o) => o.key);
}

/**
 * Like listKeys but also returns each object's last-modified time. The
 * storage reconcile uses this to skip deleting objects that were written very
 * recently — an in-flight upload lands its bytes in B2 a moment before its
 * Document row is created, so a reconcile racing that window would otherwise
 * classify the fresh bytes as an orphan and delete them (D3 TOCTOU).
 */
export async function listObjects(
  b2Config: B2Config,
  prefix: string
): Promise<{ key: string; lastModified?: Date }[]> {
  const s3 = _initS3(b2Config);
  const objs: { key: string; lastModified?: Date }[] = [];
  let token: string | undefined;
  do {
    const page: AWS.S3.ListObjectsV2Output = await new Promise(
      (resolve, reject) => {
        s3.listObjectsV2(
          {
            Bucket: b2Config.bucket,
            Prefix: prefix,
            ...(token ? { ContinuationToken: token } : {})
          },
          (err, data) => (err ? reject(err) : resolve(data))
        );
      }
    );
    for (const o of page.Contents || []) {
      if (o.Key) objs.push({ key: o.Key, lastModified: o.LastModified });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return objs;
}

/**
 * List every stored version of a single key. B2 buckets keep all versions by
 * default, so a version-less delete only writes a delete marker — callers
 * that want a REAL delete enumerate versions first and pass them to
 * deleteFiles. Exact-key match only.
 */
export function listFileVersions(
  b2Config: B2Config,
  url: string
): Promise<{ url: string; versionId?: string }[]> {
  const s3 = _initS3(b2Config);
  return new Promise((resolve, reject) => {
    s3.listObjectVersions(
      { Bucket: b2Config.bucket, Prefix: url },
      (err, data) => {
        if (err) {
          return reject(err);
        }
        const versions = [
          ...(data.Versions || []),
          ...(data.DeleteMarkers || [])
        ]
          .filter((v) => v.Key === url)
          .map((v) => ({ url, versionId: v.VersionId }));
        resolve(versions);
      }
    );
  });
}

export function deleteFiles(
  b2Config: B2Config,
  urlsIds: { url: string; versionId?: string }[]
) {
  logger.debug(`delete ${JSON.stringify(urlsIds)} from s3`);
  return new Promise<AWS.S3.DeleteObjectsOutput>((resolve, reject) => {
    try {
      const s3 = _initS3(b2Config);
      s3.deleteObjects(
        {
          Bucket: b2Config.bucket,
          Delete: {
            Objects: urlsIds.map(({ url, versionId }) => ({
              Key: url,
              VersionId: versionId
            }))
          }
        },
        (err, data) => {
          if (err) {
            logger.error(err);
            return reject(err);
          }
          logger.debug({ data });
          resolve(data);
        }
      );
    } catch (error) {
      reject(error);
    }
  });
}
