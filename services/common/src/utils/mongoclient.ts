import mongoose, { Mongoose } from 'mongoose';
import EnvironmentConfig from './environmentconfig.js';
import logger from './logger.js';

process.on('SIGINT', async () => {
  try {
    await MongoClient.getInstance()?.disconnect();
  } catch (error) {
    logger.error(String(error));
  }
});

export default class MongoClient {
  private static instance: MongoClient | null = null;
  static getInstance(envConfig?: EnvironmentConfig) {
    if (!MongoClient.instance) {
      if (!envConfig) {
        throw new Error('envConfig is required');
      }
      MongoClient.instance = new MongoClient(envConfig);
    }
    return MongoClient.instance;
  }
  private _connection: Mongoose | null = null;
  private envConfig: EnvironmentConfig;

  private constructor(envConfig: EnvironmentConfig) {
    this.envConfig = envConfig;
  }

  async connect() {
    if (!this._connection) {
      const config = this.envConfig.getValues();
      const obfuscatedConfig = this.envConfig.getObfuscatedValues();
      if (!config.MONGO_URL) {
        throw new Error('MONGO_URL is not set');
      }
      logger.debug(`connecting to ${obfuscatedConfig.MONGO_URL}...`);
      mongoose.set('strictQuery', true);
      // E21: wire connection-event listeners BEFORE connect so the
      // initial drop/error/reconnect transitions are captured. The
      // service /health endpoint (services/common/src/utils/service.ts)
      // reads connection.readyState — without these listeners we never
      // logged WHY the state changed, leaving operators staring at a
      // 503 with no breadcrumb. Listeners are attached on the global
      // `mongoose.connection` (singleton) so reattaching across multiple
      // connect() calls is a no-op-by-design (mongoose dedupes by name).
      mongoose.connection.on('disconnected', () => {
        logger.warn('mongo connection disconnected');
      });
      mongoose.connection.on('reconnected', () => {
        logger.info('mongo connection reconnected');
      });
      mongoose.connection.on('error', (err) => {
        logger.error(`mongo connection error: ${(err as Error)?.message || err}`);
      });
      this._connection = await mongoose.connect(config.MONGO_URL);
      logger.debug('db connected');
      await this._syncIndexes();
      logger.debug('db indexes synced, ready');
    }
  }

  private async _syncIndexes() {
    // E13: a single failing index sync (most commonly an existing legacy
    // index that conflicts with the current schema definition, e.g. the
    // `properties.property.realmId_1_properties.property.atakNumber_1`
    // case documented in collections/tenant.ts) used to crash the entire
    // service boot. Log and continue so the remaining models still get
    // their indexes synced and the service comes up — operators can fix
    // the offending model out-of-band.
    const modelNames = mongoose.modelNames();
    for (const name of modelNames) {
      try {
        await mongoose.model(name).syncIndexes();
      } catch (error) {
        logger.error(
          `failed to sync indexes for model ${name}: ${(error as Error)?.message || error}`
        );
      }
    }
  }

  get connection() {
    return this._connection?.connection ?? null;
  }

  async disconnect() {
    if (this._connection) {
      logger.debug('disconnecting db...');
      await mongoose.disconnect();
      this._connection = null;
      logger.debug('db disconnected');
    }
  }

  async dropCollection(collection: string) {
    if (this._connection) {
      logger.debug(`dropping collection ${collection}...`);
      await this._connection.connection.db.dropCollection(collection);
      logger.debug(`collection ${collection} dropped`);
    }
  }
}
