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

  const data: Record<string, any[]> = {};
  for (const collName of COLLECTIONS_TO_BACKUP) {
    try {
      const docs = await db.collection(collName).find({}).toArray();
      data[collName] = docs.map(serializeDoc);
    } catch (e) {
      data[collName] = [];
    }
  }

  const exportPayload = {
    version: 1,
    exportDate: new Date().toISOString(),
    database: db.databaseName,
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

  const payload = req.body;

  if (!payload || !payload.collections || payload.version !== 1) {
    throw new ServiceError(
      'Invalid backup file. Expected version 1 format.',
      422
    );
  }

  const results: Record<string, { deleted: number; inserted: number }> = {};

  for (const collName of COLLECTIONS_TO_BACKUP) {
    const docs = payload.collections[collName];
    if (!Array.isArray(docs)) {
      results[collName] = { deleted: 0, inserted: 0 };
      continue;
    }

    const collection = db.collection(collName);

    const deleteResult = await collection.deleteMany({});
    const deleted = deleteResult.deletedCount || 0;

    let inserted = 0;
    if (docs.length > 0) {
      const deserialized = docs.map(deserializeDoc);
      const insertResult = await collection.insertMany(deserialized);
      inserted = insertResult.insertedCount || 0;
    }

    results[collName] = { deleted, inserted };
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
