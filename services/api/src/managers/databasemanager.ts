import * as Express from 'express';
import axios from 'axios';
import { Types as MongooseTypes } from 'mongoose';
import { ObjectId } from 'mongodb';
import {
  Collections,
  Middlewares,
  Service,
  ServiceError,
  logger
} from '@microrealestate/common';

const COLLECTIONS_TO_BACKUP = [
  'accounts',
  'realms',
  'leases',
  'occupants',
  'properties',
  'buildings',
  'templates',
  'documents',
  'emails',
  'bills'
];

function requireAdmin(req: any, res: Express.Response, next: Express.NextFunction) {
  if (req.user?.role !== 'administrator') {
    return res.status(403).json({ message: 'Administrator access required' });
  }
  next();
}

function serializeDoc(doc: any): any {
  if (doc === null || doc === undefined) return doc;
  if (doc instanceof ObjectId) return { __oid: doc.toHexString() };
  if (doc instanceof Date) return { __date: doc.toISOString() };
  if (Buffer.isBuffer(doc)) return { __binary: doc.toString('base64') };
  if (Array.isArray(doc)) return doc.map(serializeDoc);
  if (typeof doc === 'object') {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(doc)) {
      result[key] = serializeDoc(value);
    }
    return result;
  }
  return doc;
}

function deserializeDoc(doc: any): any {
  if (doc === null || doc === undefined) return doc;
  if (Array.isArray(doc)) return doc.map(deserializeDoc);
  if (typeof doc === 'object') {
    if (doc.__oid && typeof doc.__oid === 'string') {
      return new ObjectId(doc.__oid);
    }
    if (doc.__date && typeof doc.__date === 'string') {
      return new Date(doc.__date);
    }
    if (doc.__binary && typeof doc.__binary === 'string') {
      return Buffer.from(doc.__binary, 'base64');
    }
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(doc)) {
      result[key] = deserializeDoc(value);
    }
    return result;
  }
  return doc;
}

async function backup(
  req: Express.Request,
  res: Express.Response
) {
  const db = Service.getInstance().mongoClient?.connection?.db;
  if (!db) {
    throw new ServiceError('Database not available', 500);
  }

  const realmId = (req as any).realm?._id;
  if (!realmId) {
    throw new ServiceError('Realm not resolved', 400);
  }

  const data: Record<string, any[]> = {};
  for (const collName of COLLECTIONS_TO_BACKUP) {
    // The accounts collection has no realmId — it's the global user table
    // and is intentionally excluded from per-realm backups.
    if (collName === 'accounts') {
      data[collName] = [];
      continue;
    }
    try {
      // The realms collection itself has no `realmId` field (it IS the
      // realm) — and its `_id` is an ObjectId in Mongo while `realmId`
      // arrives as a string from the middleware. Raw collection.find
      // doesn't coerce the types, so the previous `{_id: realmId}` filter
      // matched zero docs and the backup's realms array was always empty.
      // Use Mongoose's findById which casts string → ObjectId for us.
      if (collName === 'realms') {
        const realmDoc = await Collections.Realm.findById(realmId).lean();
        data[collName] = realmDoc ? [serializeDoc(realmDoc)] : [];
      } else {
        const docs = await db
          .collection(collName)
          .find({ realmId })
          .toArray();
        data[collName] = docs.map(serializeDoc);
      }
    } catch (e) {
      data[collName] = [];
    }
  }

  const exportPayload = {
    version: 1,
    exportDate: new Date().toISOString(),
    database: db.databaseName,
    realmId: String(realmId),
    collections: data
  };

  const filename = `mre_backup_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.json(exportPayload);
}

async function restore(
  req: Express.Request,
  res: Express.Response
) {
  const db = Service.getInstance().mongoClient?.connection?.db;
  if (!db) {
    throw new ServiceError('Database not available', 500);
  }

  const realmId = (req as any).realm?._id;
  if (!realmId) {
    throw new ServiceError('Realm not resolved', 400);
  }
  const realmIdStr = String(realmId);

  const payload = req.body;

  if (!payload || !payload.collections || payload.version !== 1) {
    throw new ServiceError(
      'Invalid backup file. Expected version 1 format.',
      422
    );
  }

  const results: Record<
    string,
    { deleted: number; inserted: number; skipped?: number; error?: string }
  > = {};

  // DRY-RUN VALIDATION: walk the entire payload BEFORE deleting anything.
  // If a single document claims a different realmId, abort with 422 and
  // leave the database untouched. The previous "wipe-then-validate" path
  // would delete the realm's data and only then refuse the bad docs,
  // resulting in a permanent data-loss footgun on payloads with even one
  // misrouted entry.
  for (const [collName, docs] of Object.entries(payload.collections)) {
    if (collName === 'accounts') continue;
    if (!Array.isArray(docs)) continue;
    // The realms collection's documents identify themselves by _id, not
    // realmId — skip the cross-realm guard for that collection.
    if (collName === 'realms') continue;
    for (const rawDoc of docs as any[]) {
      const d = deserializeDoc(rawDoc);
      if (d && d.realmId != null && String(d.realmId) !== realmIdStr) {
        throw new ServiceError(
          `Restore aborted: doc in ${collName} has realmId mismatch`,
          422
        );
      }
    }
  }

  for (const collName of COLLECTIONS_TO_BACKUP) {
    // accounts is global (no realmId) — never wipe or restore it via the
    // per-realm backup endpoint.
    if (collName === 'accounts') {
      results[collName] = { deleted: 0, inserted: 0 };
      continue;
    }

    const docs = payload.collections[collName];
    if (!Array.isArray(docs)) {
      results[collName] = { deleted: 0, inserted: 0 };
      continue;
    }

    const collection = db.collection(collName);

    // Only wipe THIS realm's documents — never the whole collection.
    // realmId is a STRING from the middleware; Mongo stores realm._id as
    // ObjectId. Raw collection.deleteMany does not coerce, so we must cast
    // when matching against `_id` directly (the realms special case).
    const realmObjectId = new MongooseTypes.ObjectId(realmIdStr);
    const deleteFilter =
      collName === 'realms' ? { _id: realmObjectId } : { realmId };

    // Only accept docs whose realmId matches the caller's realm. A backup
    // from another realm or an injected payload must not cross over.
    const deserialized = docs.map(deserializeDoc);
    const matching = deserialized.filter((d: any) => {
      if (!d) return false;
      // For the realms collection, match the _id of the current realm.
      if (collName === 'realms') {
        return d._id != null && String(d._id) === realmIdStr;
      }
      if (d.realmId == null) return false;
      return String(d.realmId) === realmIdStr;
    });
    const skipped = deserialized.length - matching.length;

    // D6 (audit-2026-07): NAS mongo is a standalone 4.4 (no multi-document
    // transactions), so we cannot wrap the whole restore in one atomic unit.
    // Make each collection self-contained instead: wipe + reinsert inside a
    // per-collection try/catch with insertMany({ordered:false}) so a single
    // schema-invalid or duplicate-key legacy doc does not (a) abort the rest
    // of THIS collection or (b) leave later collections wiped-but-empty. Any
    // failure is recorded per collection and surfaced to the operator instead
    // of throwing mid-loop and leaving a torn, half-restored realm.
    let deleted = 0;
    let inserted = 0;
    let collError: string | undefined;
    try {
      const deleteResult = await collection.deleteMany(deleteFilter);
      deleted = deleteResult.deletedCount || 0;

      if (matching.length > 0) {
        try {
          const insertResult = await collection.insertMany(matching, {
            ordered: false
          });
          inserted = insertResult.insertedCount || 0;
        } catch (insErr: any) {
          // ordered:false keeps inserting past a bad doc; the driver still
          // throws a BulkWriteError carrying the count that DID land.
          inserted =
            insErr?.result?.nInserted ??
            insErr?.result?.insertedCount ??
            insErr?.insertedCount ??
            0;
          collError = `partial insert: ${insErr?.message || insErr}`;
          logger.error(
            `restore: ${collName} inserted ${inserted}/${matching.length} — ${collError}`
          );
        }
      }
    } catch (err: any) {
      collError = String(err?.message || err);
      logger.error(`restore: ${collName} failed — ${collError}`);
    }

    results[collName] = { deleted, inserted, skipped, ...(collError ? { error: collError } : {}) };
  }

  const failedCollections = Object.entries(results)
    .filter(([, r]) => r.error)
    .map(([name]) => name);
  if (failedCollections.length) {
    logger.error(
      `Database restore completed WITH ERRORS in: ${failedCollections.join(', ')} (backup dated ${payload.exportDate})`
    );
  } else {
    logger.info(`Database restored from backup dated ${payload.exportDate}`);
  }

  // Storage reconcile (best-effort): the restore only rewrote MONGO. Files
  // uploaded AFTER the backup date are now orphaned in B2 (bytes with no
  // record), and records resurrected for since-deleted files point at
  // nothing. Ask the pdfgenerator (which owns B2 access) to diff + clean,
  // and surface its report to the caller. A reconcile failure must never
  // fail the restore itself.
  let storageReconcile: Record<string, any> = { enabled: false };
  try {
    const { PDFGENERATOR_URL } = Service.getInstance().envConfig.getValues();
    // D1 (audit-2026-07): restore must NEVER auto-delete B2 files. Restoring
    // an OLDER backup makes every file uploaded since then "unreferenced";
    // an auto-delete would permanently destroy them (and the empty-array
    // backup edge would nuke the whole realm's files). Run reconcile in
    // DRY-RUN — report orphaned/missing files to the operator, delete nothing.
    // Actual cleanup is an explicit, separate, admin-confirmed action.
    const reconcileResp = await axios.post(
      `${PDFGENERATOR_URL}/documents/reconcile-storage`,
      { dryRun: true },
      {
        headers: {
          authorization: (req.headers as any).authorization,
          organizationid:
            (req.headers as any).organizationid || realmIdStr
        },
        timeout: 120_000
      }
    );
    storageReconcile = reconcileResp.data;
  } catch (err: any) {
    logger.warn(
      `restore: storage reconcile failed (non-blocking): ${err?.message || err}`
    );
    storageReconcile = { enabled: true, error: 'reconcile failed' };
  }

  res.json({
    // D6 (audit-2026-07): a partial restore must not masquerade as a clean
    // one. Report which collections failed so the operator knows to re-run
    // rather than trust a torn realm.
    status: failedCollections.length ? 'restored_with_errors' : 'restored',
    exportDate: payload.exportDate,
    failedCollections,
    results,
    storageReconcile
  });
}

export default {
  requireAdmin,
  backup: Middlewares.asyncWrapper(backup),
  restore: Middlewares.asyncWrapper(restore)
};
