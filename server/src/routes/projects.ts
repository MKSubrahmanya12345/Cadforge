import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { subscribe } from '../events.js';
import { createLogger } from '../logger.js';
import { asyncRoute, badRequest, notFound } from '../middleware/error.js';
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  type ProjectDoc,
} from '../models/project.js';
import { getLibrary } from '../models/part.js';
import { runPipeline } from '../pipeline/orchestrator.js';
import type { PartStore, PipelineContext } from '../pipeline/types.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import { TavilySearchProvider } from '../providers/tavily.js';
import { storageRoot } from '../worker.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const log = createLogger('routes:projects');

export const projectsRouter: Router = Router();

const CreateBodySchema = z.object({
  prompt: z.string().min(3, 'prompt must be at least 3 characters').max(2000),
});

const IdSchema = z.string().min(1).max(64);

const FORMATS = ['step', 'glb', 'stl', 'fcstd'] as const;
type Format = (typeof FORMATS)[number];

const CONTENT_TYPES: Record<Format, string> = {
  step: 'model/step',
  glb: 'model/gltf-binary',
  stl: 'model/stl',
  fcstd: 'application/octet-stream',
};

const EXTENSIONS: Record<Format, string> = {
  step: '.step',
  glb: '.glb',
  stl: '.stl',
  fcstd: '.FCStd',
};

/** Live providers; constructed once so connections are reused. */
let llmProvider: AnthropicProvider | null = null;
let searchProvider: TavilySearchProvider | null = null;

export function getProviders(): { llm: AnthropicProvider; search: TavilySearchProvider } {
  llmProvider ??= new AnthropicProvider();
  searchProvider ??= new TavilySearchProvider();
  return { llm: llmProvider, search: searchProvider };
}

const mongoPartStore: PartStore = {
  async findByName(name) {
    const all = await getLibrary();
    const { matchPart } = await import('@cadforge/shared');
    return matchPart(name, all, 0.9);
  },
  async listAll() {
    return getLibrary();
  },
  async listLibraryNames() {
    const all = await getLibrary();
    return all.map((p) => p.name);
  },
  async upsert(spec) {
    const { upsertPart } = await import('../models/part.js');
    await upsertPart(spec);
  },
};

function serialize(doc: ProjectDoc) {
  return {
    _id: String(doc._id),
    prompt: doc.prompt,
    status: doc.status,
    plan: doc.plan,
    assembly: doc.assembly,
    artifacts: doc.artifacts,
    logs: doc.logs,
    scaleChecks: doc.scaleChecks ?? [],
    progress: doc.progress,
    error: doc.error,
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
  };
}

// POST /projects
projectsRouter.post(
  '/',
  asyncRoute(async (req: Request, res: Response) => {
    const body = CreateBodySchema.parse(req.body);
    const doc = await createProject(body.prompt);
    const projectId = String(doc._id);

    const { llm, search } = getProviders();
    const context: PipelineContext = {
      projectId,
      prompt: body.prompt,
      llm,
      search,
      parts: mongoPartStore,
      log: () => undefined,
      status: () => undefined,
      progress: () => undefined,
    };

    // Fire and forget: the client follows progress over SSE.
    void runPipeline(context).catch((err: unknown) => {
      log.error('pipeline crashed', { projectId, err: err instanceof Error ? err.message : String(err) });
    });

    log.info('project created', { projectId });
    res.status(202).json({ projectId, status: doc.status });
  }),
);

// GET /projects
projectsRouter.get(
  '/',
  asyncRoute(async (_req: Request, res: Response) => {
    const docs = await listProjects();
    res.json(
      docs.map((d) => ({
        _id: String(d._id),
        prompt: d.prompt,
        status: d.status,
        progress: d.progress,
        artifacts: d.artifacts,
        error: d.error,
        createdAt: new Date(d.createdAt).toISOString(),
      })),
    );
  }),
);

// GET /projects/:id
projectsRouter.get(
  '/:id',
  asyncRoute(async (req: Request, res: Response) => {
    const id = IdSchema.parse(req.params['id']);
    const doc = await getProject(id);
    if (!doc) throw notFound(`No project with id ${id}`);
    res.json(serialize(doc));
  }),
);

// GET /projects/:id/events  (SSE)
projectsRouter.get('/:id/events', (req: Request, res: Response) => {
  const id = String(req.params['id'] ?? '');

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const write = (event: string, data: unknown): void => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  write('open', { projectId: id });

  const unsubscribe = subscribe(id, (event) => {
    write(event.type, event.data);
    if (event.type === 'done' || event.type === 'error') {
      res.write(': closing\n\n');
    }
  });

  // Keep-alive comment so proxies do not time the stream out.
  const keepAlive = setInterval(() => {
    res.write(': ping\n\n');
  }, 20_000);

  const cleanup = (): void => {
    clearInterval(keepAlive);
    unsubscribe();
    res.end();
  };

  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('error', cleanup);
});

// GET /projects/:id/files/:format
projectsRouter.get(
  '/:id/files/:format',
  asyncRoute(async (req: Request, res: Response) => {
    const id = IdSchema.parse(req.params['id']);
    const format = z.enum(FORMATS).parse(req.params['format']);

    const doc = await getProject(id);
    if (!doc) throw notFound(`No project with id ${id}`);

    const relative = doc.artifacts[format];
    if (!relative) {
      throw notFound(`Format "${format}" was not produced for this project`);
    }

    // Sanitise: the stored value must stay inside the storage root.
    const full = resolve(storageRoot, relative);
    if (!full.startsWith(resolve(storageRoot))) {
      throw badRequest('Refusing to serve a path outside the storage root');
    }
    if (!existsSync(full)) {
      throw notFound(`File for format "${format}" is missing from disk`);
    }

    const filename = `${id}${EXTENSIONS[format]}`;
    res.setHeader('Content-Type', CONTENT_TYPES[format]);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    log.debug('serving artifact', { id, format, path: full });
    res.sendFile(full);
  }),
);

// GET /projects/:id/file-paths  (for the viewer's GLB/STEP/STL loaders)
projectsRouter.get(
  '/:id/file-paths',
  asyncRoute(async (req: Request, res: Response) => {
    const id = IdSchema.parse(req.params['id']);
    const doc = await getProject(id);
    if (!doc) throw notFound(`No project with id ${id}`);

    const url = (relative: string | null): string | null =>
      relative ? `/files/${relative.replace(/\\/g, '/')}` : null;

    res.json({
      step: url(doc.artifacts.step),
      glb: url(doc.artifacts.glb),
      stl: url(doc.artifacts.stl),
      fcstd: url(doc.artifacts.fcstd),
    });
  }),
);

// DELETE /projects/:id
projectsRouter.delete(
  '/:id',
  asyncRoute(async (req: Request, res: Response) => {
    const id = IdSchema.parse(req.params['id']);
    const ok = await deleteProject(id);
    if (!ok) throw notFound(`No project with id ${id}`);
    res.status(204).end();
  }),
);

export { mongoPartStore, serialize };
