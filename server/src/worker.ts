import { join, resolve } from 'node:path';
import { env, REPO_ROOT } from './env.js';
import { createLogger } from './logger.js';
import type { Bbox, PartSpec } from '@cadforge/shared';
import { PartSpecSchema, Vec3Schema } from '@cadforge/shared';
import { z } from 'zod';

const log = createLogger('worker-client');

/** Only these characters may appear in a path segment. */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,120}$/;

function safeSegment(value: string, label: string): string {
  if (!SAFE_SEGMENT.test(value) || value.includes('..')) {
    throw new Error(`unsafe ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

export const WorkerPartSchema = z.object({
  instance_name: z.string().min(1).max(200),
  part_id: z.string().min(1).max(200),
  code: z.string().min(1).max(400_000),
  spec: PartSpecSchema,
});

export const WorkerGenerateRequestSchema = z.object({
  parts: z.array(WorkerPartSchema).min(1).max(48),
});

export const WorkerItemSchema = z.object({
  instance_name: z.string().min(1).max(200),
  part_id: z.string().min(1).max(200),
  spec: PartSpecSchema,
  position_mm: Vec3Schema,
  rotation_deg: Vec3Schema,
  color_hex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  code: z.string().max(400_000).optional(),
  step_path: z.string().max(1024).optional(),
});

export const WorkerExportRequestSchema = z.object({
  project_id: z.string().min(1).max(200),
  items: z.array(WorkerItemSchema).min(1).max(48),
});

export const WorkerBboxSchema = z.object({ x: z.number(), y: z.number(), z: z.number() });

export const WorkerExportResponseSchema = z.object({
  ok: z.boolean(),
  step_path: z.string().nullable().default(null),
  glb_path: z.string().nullable().default(null),
  stl_path: z.string().nullable().default(null),
  fcstd_path: z.string().nullable().default(null),
  per_part: z
    .array(
      z.object({
        instance_name: z.string(),
        step_path: z.string().nullable().default(null),
        glb_path: z.string().nullable().default(null),
      }),
    )
    .default([]),
  assembly_bbox_mm: WorkerBboxSchema.nullable().default(null),
  skipped: z.array(z.string()).default([]),
  error: z.string().nullable().default(null),
});

export const WorkerGenerateResponseSchema = z.object({
  ok: z.boolean(),
  instance_name: z.string(),
  fallback: z.boolean().default(false),
  valid: z.boolean(),
  attempts: z.number().int().default(1),
  bbox: z
    .object({
      expected: WorkerBboxSchema,
      actual: WorkerBboxSchema,
      delta_mm: WorkerBboxSchema,
      ok: z.boolean(),
      failing_axes: z.array(z.enum(['x', 'y', 'z'])),
    })
    .nullable()
    .default(null),
  features: z
    .array(
      z.object({
        name: z.string(),
        type: z.string(),
        position_mm: WorkerBboxSchema,
        diameter_mm: z.number().nullable().default(null),
        depth_mm: z.number().nullable().default(null),
        matched: z.boolean(),
        delta_mm: z.number().nullable().default(null),
      }),
    )
    .default([]),
  error: z.string().nullable().default(null),
  glb_path: z.string().nullable().default(null),
  stl_path: z.string().nullable().default(null),
  step_path: z.string().nullable().default(null),
});

export const WorkerFallbackRequestSchema = z.object({
  instance_name: z.string().min(1).max(200),
  spec: PartSpecSchema,
});

export const WorkerHealthSchema = z.object({
  ok: z.boolean(),
  cadquery_version: z.string(),
  freecad: z.boolean(),
  version: z.string(),
});

export type WorkerGenerateResponse = z.infer<typeof WorkerGenerateResponseSchema>;
export type WorkerExportResponse = z.infer<typeof WorkerExportResponseSchema>;
export type WorkerHealth = z.infer<typeof WorkerHealthSchema>;

export class WorkerError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'WorkerError';
  }
}

export const storageRoot: string = resolve(REPO_ROOT, env.STORAGE_DIR);

/**
 * Read at call time, and re-read from the environment rather than from the
 * frozen `env` object. That gives one override point: setting
 * `process.env.CAD_WORKER_URL` repoints the worker without reloading this
 * module, which is how the e2e test swaps in its in-process fake.
 */
export function workerBaseUrl(): string {
  const fromEnv = process.env['CAD_WORKER_URL'];
  const value = typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : env.CAD_WORKER_URL;
  return value.replace(/\/$/, '');
}

export function projectDir(projectId: string): string {
  return join(storageRoot, safeSegment(projectId, 'projectId'));
}

/** Reject any path the worker returns that is not inside the storage root. */
export function assertInsideStorage(candidate: string): string {
  const full = resolve(candidate);
  if (!full.startsWith(resolve(storageRoot))) {
    throw new WorkerError(`worker returned a path outside the storage root: ${candidate}`);
  }
  return full;
}

/**
 * Is the worker on this machine?
 *
 * This decides who serves /files. When the worker is local, the server has the
 * bytes on its own disk and `express.static` is correct and fastest. When it is
 * remote — the API on one Render service, CadQuery on another — the worker is
 * the only host that has the files, so the server must proxy through it.
 */
export function isWorkerLocal(): boolean {
  const url = workerBaseUrl();
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return true;
  }
  // URL keeps IPv6 brackets in the hostname ("[::1]"), so strip them.
  const bare = host.replace(/^\[|\]$/g, '');
  if (bare === 'localhost' || bare === '127.0.0.1' || bare === '::1' || bare === '0.0.0.0') {
    return true;
  }
  // A container talking to a sibling service by name is local to the host's
  // network, but the bytes are still in a different filesystem unless the
  // storage directory is a shared volume, so treat it as remote. That is the
  // safe direction: proxying always works, local static does not.
  return false;
}

/** URL on the worker that serves one artifact. */
export function workerFileUrl(relativePath: string): string {
  const clean = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean.includes('..')) {
    throw new WorkerError(`refusing to request a traversing path from the worker: ${relativePath}`);
  }
  return `${workerBaseUrl()}/files/${clean.split('/').map(encodeURIComponent).join('/')}`;
}

/** Fetch an artifact's bytes from the worker (used when it is not local). */
export async function fetchWorkerFile(
  relativePath: string,
  timeoutMs = 60_000,
): Promise<{ body: ArrayBuffer; contentType: string; contentLength: number }> {
  const url = workerFileUrl(relativePath);
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new WorkerError(
      `could not fetch ${relativePath} from the cad-worker at ${url} (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }
  if (!res.ok) {
    throw new WorkerError(
      `cad-worker returned HTTP ${res.status} for ${relativePath}`,
      res.status,
    );
  }
  const body = await res.arrayBuffer();
  return {
    body,
    contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    contentLength: Number(res.headers.get('content-length') ?? body.byteLength),
  };
}

/** A Zod schema, used for both parse and safeParse. */
interface Schema<T> {
  parse(v: unknown): T;
  safeParse(v: unknown): { success: true; data: T } | { success: false; error: z.ZodError };
}

async function post<T>(
  route: string,
  body: unknown,
  schema: Schema<T>,
  timeoutMs: number,
): Promise<T> {
  const url = `${workerBaseUrl()}${route}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new WorkerError(
      `cad-worker unreachable at ${url} (${detail}). Start it with: cd cad-worker && uvicorn app.main:app --reload --port 8000`,
    );
  }

  const text = await res.text();
  if (!res.ok) {
    throw new WorkerError(`cad-worker ${route} returned HTTP ${res.status}: ${text.slice(0, 500)}`, res.status);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WorkerError(`cad-worker ${route} returned non-JSON: ${text.slice(0, 300)}`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new WorkerError(
      `cad-worker ${route} response failed validation: ${result.error.issues
        .slice(0, 5)
        .map((i: z.ZodIssue) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return result.data;
}

export async function workerHealth(timeoutMs = 4000): Promise<WorkerHealth> {
  const url = `${workerBaseUrl()}/health`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new WorkerError(`cad-worker health check returned HTTP ${res.status}`, res.status);
  }
  return WorkerHealthSchema.parse(await res.json());
}

/**
 * Run one LLM codegen attempt for a part. The worker measures and validates;
 * it does not retry — the server owns the retry loop.
 */
export async function workerGenerate(
  instanceName: string,
  spec: PartSpec,
  code: string,
): Promise<WorkerGenerateResponse> {
  const request = WorkerGenerateRequestSchema.parse({
    parts: [{ instance_name: instanceName, part_id: spec.id, code, spec }],
  });
  return post(
    '/generate',
    request,
    WorkerGenerateResponseSchema,
    (env.CODE_TIMEOUT_S + 15) * 1000,
  );
}

/** Deterministic builder. Always succeeds dimensionally; may still fail hard. */
export async function workerFallback(
  instanceName: string,
  spec: PartSpec,
): Promise<WorkerGenerateResponse> {
  return post(
    '/fallback/part',
    WorkerFallbackRequestSchema.parse({ instance_name: instanceName, spec }),
    WorkerGenerateResponseSchema,
    (env.CODE_TIMEOUT_S + 15) * 1000,
  );
}

export interface ExportItemInput {
  instanceName: string;
  spec: PartSpec;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  code: string;
}

export async function workerExport(
  projectId: string,
  items: ExportItemInput[],
): Promise<WorkerExportResponse> {
  const request = WorkerExportRequestSchema.parse({
    project_id: safeSegment(projectId, 'projectId'),
    items: items.map((i) => ({
      instance_name: i.instanceName,
      part_id: i.spec.id,
      spec: i.spec,
      position_mm: i.position,
      rotation_deg: i.rotation,
      color_hex: i.spec.color_hex,
      code: i.code,
    })),
  });
  return post('/export', request, WorkerExportResponseSchema, 180_000);
}

/** Bounding box of an assembly computed server-side, for the verify stage. */
export function assemblyBbox(
  items: Array<{ spec: PartSpec; position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number } }>,
): Bbox {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const item of items) {
    const { x, y, z } = item.spec.bbox_mm;
    // Support axis-aligned rotation for the verify check; full rotation extent
    // is computed in shared/geometry for the viewer.
    const swapXY = Math.abs(item.rotation.z % 180) > 45;
    const swapXZ = Math.abs(item.rotation.y % 180) > 45;
    const swapYZ = Math.abs(item.rotation.x % 180) > 45;
    const ex = swapXY ? y : x;
    const ey = swapXY ? x : y;
    const ez = swapXZ || swapYZ ? Math.max(x, y, z) : z;
    minX = Math.min(minX, item.position.x);
    minY = Math.min(minY, item.position.y);
    minZ = Math.min(minZ, item.position.z);
    maxX = Math.max(maxX, item.position.x + ex);
    maxY = Math.max(maxY, item.position.y + ey);
    maxZ = Math.max(maxZ, item.position.z + ez);
  }
  if (minX === Infinity) return { x: 1, y: 1, z: 1 };
  return {
    x: Math.max(maxX - minX, 1e-6),
    y: Math.max(maxY - minY, 1e-6),
    z: Math.max(maxZ - minZ, 1e-6),
  };
}

log.debug('worker client configured', { base: env.CAD_WORKER_URL, storageRoot });
