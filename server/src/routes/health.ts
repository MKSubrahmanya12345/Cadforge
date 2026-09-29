import { Router, type Request, type Response } from 'express';
import { env } from '../env.js';
import { asyncRoute } from '../middleware/error.js';
import { pingDb } from '../db.js';
import { workerHealth } from '../worker.js';

export const healthRouter: Router = Router();

/** GET /health — checks Mongo, cad-worker, LLM key, search key. */
healthRouter.get(
  '/',
  asyncRoute(async (_req: Request, res: Response) => {
    const [mongo, worker] = await Promise.all([
      pingDb().catch((err: unknown) => ({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })),
      workerHealth(4000).catch((err: unknown) => ({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        cadquery_version: 'unavailable',
        freecad: false,
        version: 'unavailable',
      })),
    ]);

    const llmKeyPresent = env.ANTHROPIC_API_KEY.length > 0;
    const searchKeyPresent = env.TAVILY_API_KEY.length > 0;

    const body = {
      status: mongo.ok && worker.ok ? 'ok' : 'degraded',
      mongo: { ok: mongo.ok, error: mongo.error ?? null },
      cadWorker: {
        ok: worker.ok,
        url: env.CAD_WORKER_URL,
        cadquery_version: worker.ok ? worker.cadquery_version : 'unavailable',
        freecad: worker.ok ? worker.freecad : false,
        error: worker.ok ? null : (worker as { error?: string }).error ?? 'unreachable',
      },
      llm: {
        ok: llmKeyPresent,
        provider: 'anthropic',
        model: env.ANTHROPIC_MODEL,
        key_present: llmKeyPresent,
      },
      search: {
        ok: searchKeyPresent,
        provider: 'tavily',
        key_present: searchKeyPresent,
      },
      storage_dir: env.STORAGE_DIR,
      uptime_s: Math.round(process.uptime()),
    };

    res.status(body.status === 'ok' ? 200 : 503).json(body);
  }),
);
