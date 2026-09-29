import mongoose from 'mongoose';
import { env } from './env.js';
import { createLogger } from './logger.js';

const log = createLogger('db');

let connected = false;

export async function connectDb(uri: string = env.MONGODB_URI): Promise<typeof mongoose> {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
    maxPoolSize: 20,
  });
  connected = true;
  log.info('MongoDB connected');
  return mongoose;
}

export function isDbConnected(): boolean {
  return connected && mongoose.connection.readyState === 1;
}

export async function disconnectDb(): Promise<void> {
  connected = false;
  await mongoose.disconnect();
}

export async function pingDb(): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!isDbConnected()) {
      await connectDb();
    }
    await mongoose.connection.db?.admin().ping();
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('MongoDB ping failed', { message });
    return { ok: false, error: message };
  }
}
