import { connectDb, disconnectDb } from '../db.js';
import { configureLogger, createLogger } from '../logger.js';
import { env } from '../env.js';
import { SEED_PARTS, SEED_VERSION } from './parts.js';
import { upsertPart, PartModel } from '../models/part.js';
import { SEED_META_ID } from './meta.js';

const log = createLogger('seed');

/**
 * Load the seed library into Mongo.
 *
 * Seeded parts are marked verified=true because they carry curated datasheet
 * sources. Anything the spec flagged as approximate keeps a lower confidence so
 * the UI still shows a warning badge, but is not re-researched.
 */
export async function seed(): Promise<{ inserted: number; updated: number }> {
  let inserted = 0;
  let updated = 0;

  for (const part of SEED_PARTS) {
    const existing = await PartModel.findOne({ id: part.id }).lean().exec();
    await upsertPart(part, { markVerified: true });
    if (existing) updated += 1;
    else inserted += 1;
    log.info(
      `${existing ? 'updated' : 'inserted'} ${part.id} — ${part.name} (${part.bbox_mm.x}×${part.bbox_mm.y}×${part.bbox_mm.z} mm, confidence ${part.confidence})`,
    );
  }

  await PartModel.updateOne(
    { id: SEED_META_ID },
    { $set: { name: 'seed metadata', category: 'other', confidence: 1, version: SEED_VERSION, seededAt: new Date() } },
    { upsert: true },
  );

  log.info(`seed complete: ${inserted} inserted, ${updated} updated`);
  return { inserted, updated };
}

async function main(): Promise<void> {
  configureLogger(env.LOG_LEVEL);
  log.info('connecting to MongoDB', { uri: redact(env.MONGODB_URI) });
  try {
    await connectDb();
    const result = await seed();
    log.info('done', result);
  } catch (err) {
    log.error('seed failed', { error: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  } finally {
    await disconnectDb().catch(() => undefined);
  }
}

function redact(uri: string): string {
  return uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@');
}

if (import.meta.main) {
  await main();
}
