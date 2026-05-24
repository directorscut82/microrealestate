import * as Express from 'express';
import { ObjectId } from 'mongodb';
import {
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
      const docs = await db
        .collection(collName)
        .find({ realmId })
        .toArray();
      data[collName] = docs.map(serializeDoc);
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
    { deleted: number; inserted: number; skipped?: number }
  > = {};

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
    const deleteResult = await collection.deleteMany({ realmId });
    const deleted = deleteResult.deletedCount || 0;

    // Only accept docs whose realmId matches the caller's realm. A backup
    // from another realm or an injected payload must not cross over.
    const deserialized = docs.map(deserializeDoc);
    const matching = deserialized.filter((d: any) => {
      if (!d || d.realmId == null) return false;
      return String(d.realmId) === realmIdStr;
    });
    const skipped = deserialized.length - matching.length;

    let inserted = 0;
    if (matching.length > 0) {
      const insertResult = await collection.insertMany(matching);
      inserted = insertResult.insertedCount || 0;
    }

    results[collName] = { deleted, inserted, skipped };
  }

  logger.info(`Database restored from backup dated ${payload.exportDate}`);

  res.json({
    status: 'restored',
    exportDate: payload.exportDate,
    results
  });
}

export default {
  requireAdmin,
  backup: Middlewares.asyncWrapper(backup),
  restore: Middlewares.asyncWrapper(restore)
};
