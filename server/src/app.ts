import cors from 'cors';
import express, { type Express, type Request, type Response } from 'express';
import { mcpRouter } from './mcp/server.js';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { env, REPO_ROOT } from './env.js';
import { createLogger } from './logger.js';
import { errorHandler, notFoundHandler, asyncRoute, notFound, upstream } from './middleware/error.js';
import { rateLimit } from './middleware/ratelimit.js';
import { healthRouter } from './routes/health.js';
import { partsRouter } from './routes/parts.js';
import { projectsRouter } from './routes/projects.js';
import { WorkerError, fetchWorkerFile, isWorkerLocal, storageRoot } from './worker.js';

const log = createLogger('http');

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  const origins = env.CLIENT_ORIGIN.split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.use(
    cors({
      origin: origins.length === 0 ? true : origins,
      credentials: false,
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'MCP-Protocol-Version',
        'mcp-session-id',
        'Last-Event-ID',
      ],
    }),
  );

  // Bodies here are small (a prompt and a spec), so a tight cap is safe.
  app.use(express.json({ limit: '1mb' }));

  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      if (req.path.endsWith('/events')) return;
      log.debug(`${req.method} ${req.originalUrl} -> ${res.statusCode} in ${Date.now() - started}ms`);
    });
    next();
  });

  app.use('/api', rateLimit({ prefix: 'api:' }));
  app.use('/api/health', healthRouter);
  app.use('/api/projects', projectsRouter);
  app.use('/api/parts', partsRouter);

  // MCP lives at the root /mcp, not under /api, so the client config URL is
  // https://<host>/mcp regardless of how the API is mounted.
  app.use('/', mcpRouter);

  // Generated artifacts, mounted at the API root so the client can load GLB and
  // STEP directly from /files/<projectId>/assembly.glb.
  //
  // Who holds the bytes depends on where the worker runs. Locally both processes
  // share a disk and express.static is correct. In a split deployment (API on one
  // Render service, CadQuery worker on another) the worker is the only host with
  // the files, so the server proxies them. `isWorkerLocal()` picks between the
  // two; a wrong guess in either direction is a 404, so this is the check that
  // makes both topologies work.
  if (isWorkerLocal()) {
    const storage = storageRoot;
    if (!existsSync(storage)) {
      mkdirSync(storage, { recursive: true });
      log.info('created storage directory', { path: storage });
    }
    log.info('serving artifacts from local disk', { path: storage });
    app.use(
      '/files',
      express.static(storage, {
        index: false,
        dotfiles: 'deny',
        // Artifacts are immutable once written, so cache hard.
        maxAge: '1h',
        setHeaders: (res) => {
          res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        },
      }),
    );
  } else {
    log.info('serving artifacts by proxying the cad-worker', {
      worker: env.CAD_WORKER_URL,
    });
    app.get(
      '/files/*',
      asyncRoute(async (req: Request, res: Response) => {
        const raw = req.params['0'];
        const relative = Array.isArray(raw) ? raw.join('/') : String(raw ?? '');
        if (relative.length === 0) {
          throw notFound('No artifact path given');
        }
        try {
          const file = await fetchWorkerFile(relative);
          res.setHeader('Content-Type', file.contentType);
          res.setHeader('Content-Length', String(file.contentLength));
          res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
          res.setHeader('Cache-Control', 'private, max-age=3600');
          res.send(Buffer.from(file.body));
        } catch (err) {
          if (err instanceof WorkerError) {
            throw err.status === 404
              ? notFound(err.message)
              : upstream(`The cad-worker could not serve ${relative}: ${err.message}`);
          }
          throw err;
        }
      }),
    );
  }

  // The built client, when it is present.
  //
  // This is what lets one Render web service be the whole application: same
  // origin for the UI, the API, the generated files, and /mcp, so there is no
  // CORS in the request path and nothing extra to keep alive. If the client is
  // hosted separately, this mount simply finds no directory and is skipped.
  const clientDist = resolve(REPO_ROOT, 'client', 'dist');
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
    // SPA fallback. Registered AFTER /api, /files and /mcp so those keep their
    // own 404s instead of being answered with index.html.
    app.get(/^(?!\/(api|files|mcp)\b).*/, (_req, res) => {
      res.sendFile(join(clientDist, 'index.html'));
    });
    log.info('serving the built client', { path: clientDist });
  } else {
    log.info('no client build found; run `bun run --cwd client build` to serve the UI from here');
  }

  app.get('/api', (_req, res) => {
    res.json({
      name: 'CADForge API',
      version: '1.0.0',
      endpoints: [
        'POST   /api/projects',
        'GET    /api/projects',
        'GET    /api/projects/:id',
        'GET    /api/projects/:id/events',
        'GET    /api/projects/:id/files/:format',
        'GET    /api/parts',
        'GET    /api/parts/:id',
        'POST   /api/parts/:id/verify',
        'DELETE /api/parts/:id',
        'GET    /api/health',
        'POST   /mcp             (Model Context Protocol, streamable HTTP)',
      ],
      storage: join(REPO_ROOT, env.STORAGE_DIR),
    });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
