import { createApp } from './app.js';
import { connectDb, disconnectDb } from './db.js';
import { env } from './env.js';
import { configureLogger, createLogger } from './logger.js';

configureLogger(env.LOG_LEVEL, env.NODE_ENV === 'development');

const log = createLogger('server');

async function main(): Promise<void> {
  log.info('CADForge server starting', {
    node: process.version,
    env: env.NODE_ENV,
    port: env.PORT,
    model: env.ANTHROPIC_MODEL,
    worker: env.CAD_WORKER_URL,
  });

  await connectDb();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    log.info(`API listening on http://localhost:${env.PORT}`);
    log.info(`Health check:      http://localhost:${env.PORT}/api/health`);
    log.info(`Client dev server: http://localhost:5173`);
  });

  const shutdown = (signal: string) => {
    log.info(`${signal} received, shutting down`);
    server.close(() => {
      void disconnectDb().finally(() => {
        process.exit(0);
      });
    });
    // Do not hang forever on keep-alive connections.
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  log.error('fatal startup error', { message });
  if (err instanceof Error && err.name === 'EnvValidationError') {
    // Already a clear, actionable message; print it without a stack trace.
    console.error(`\n${message}\n`);
  } else if (err instanceof Error) {
    console.error(err.stack ?? message);
  } else {
    console.error(message);
  }
  process.exit(1);
});
