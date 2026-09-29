/**
 * The bridge between MCP tools and the rest of the server.
 *
 * Tools import from here rather than reaching into models/services directly, so
 * the tool layer stays a thin, testable surface and the dependency direction
 * stays one-way (mcp -> app), never the reverse.
 */
import type { PartSpec } from '@cadforge/shared';
import { matchPart } from '@cadforge/shared';
import { env } from '../env.js';
import { getLibrary, findPartById, listParts, setVerified, deletePart } from '../models/part.js';
import { createProject, deleteProject, getProject, listProjects, type ProjectDoc } from '../models/project.js';
import { getProviders, mongoPartStore } from '../routes/projects.js';
import { runPipeline } from '../pipeline/orchestrator.js';
import { workerHealth } from '../worker.js';
import { pingDb } from '../db.js';
import type { PipelineContext, PipelineSink } from '../pipeline/types.js';
import { appendLog, updateProject } from '../models/project.js';
import { storageRoot } from '../worker.js';
import { relative, resolve } from 'node:path';

export interface McpProject {
  _id: string;
  prompt: string;
  status: string;
  progress: number;
  plan: ProjectDoc['plan'];
  assembly: ProjectDoc['assembly'];
  artifacts: ProjectDoc['artifacts'];
  logs: ProjectDoc['logs'];
  scaleChecks: Array<{ label: string; expected: number; actual: number; ok: boolean; detail: string }>;
  error: string | null;
  createdAt: string;
}

function toMcp(doc: ProjectDoc): McpProject {
  return {
    _id: String(doc._id),
    prompt: doc.prompt,
    status: doc.status,
    progress: doc.progress,
    plan: doc.plan,
    assembly: doc.assembly.map((a) => ({
      ...a,
      resolvedPosition_mm: a.resolvedPosition_mm ?? { x: 0, y: 0, z: 0 },
    })),
    artifacts: doc.artifacts,
    logs: doc.logs,
    scaleChecks: (doc.scaleChecks ?? []) as McpProject['scaleChecks'],
    error: doc.error,
    createdAt: new Date(doc.createdAt).toISOString(),
  };
}

export async function createProjectAndReturnId(prompt: string): Promise<string> {
  const doc = await createProject(prompt);
  return String(doc._id);
}

export { createProjectAndReturnId as createProject };

/** Launch the pipeline for a project, with Mongo-backed persistence. */
export async function startPipelineFor(projectId: string): Promise<void> {
  const doc = await getProject(projectId);
  if (!doc) throw new Error(`No project with id ${projectId}`);

  const { llm, search } = getProviders();
  const sink: PipelineSink = {
    appendLog: (entry) => appendLog(projectId, entry),
    patch: (fields) => updateProject(projectId, fields as never),
  };

  const context: PipelineContext = {
    projectId,
    prompt: doc.prompt,
    llm,
    search,
    parts: mongoPartStore,
    sink,
    log: () => undefined,
    status: () => undefined,
    progress: () => undefined,
  };

  void runPipeline(context).catch(() => {
    // runPipeline already records the failure on the project; nothing to add.
  });
}

export async function readProject(projectId: string): Promise<McpProject | null> {
  const doc = await getProject(projectId);
  return doc ? toMcp(doc) : null;
}

export async function listRecent(limit: number): Promise<McpProject[]> {
  const docs = await listProjects(limit);
  return docs.map(toMcp);
}

export async function removeProject(projectId: string): Promise<boolean> {
  return deleteProject(projectId);
}

/** Poll until the project settles, or the deadline passes. */
export async function waitForCompletion(
  projectId: string,
  timeoutMs: number,
): Promise<{ status: 'complete' | 'failed'; timedOut: boolean }> {
  const deadline = Date.now() + timeoutMs;
  const pollMs = 1500;
  while (Date.now() < deadline) {
    const doc = await getProject(projectId);
    if (!doc) return { status: 'failed', timedOut: false };
    if (doc.status === 'complete') return { status: 'complete', timedOut: false };
    if (doc.status === 'failed') return { status: 'failed', timedOut: false };
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { status: 'failed', timedOut: true };
}

/** Absolute URLs an agent can fetch, derived from the stored relative paths. */
export function artifactUrls(doc: McpProject): Record<string, string | null> {
  const base = publicBaseUrl();
  const out: Record<string, string | null> = {};
  for (const [format, rel] of Object.entries(doc.artifacts)) {
    out[format] = rel ? `${base}/files/${rel.replace(/\\/g, '/')}` : null;
  }
  return out;
}

function publicBaseUrl(): string {
  // CADForge runs on one host; the API is the only thing that serves files.
  return `http://localhost:${env.PORT}`;
}

export async function searchLibrary(filter: {
  q?: string;
  category?: string;
  verified?: boolean;
  limit: number;
}): Promise<PartSpec[]> {
  if (filter.q) {
    const parts = await listParts({
      q: filter.q,
      ...(filter.category ? { category: filter.category } : {}),
      ...(filter.verified !== undefined ? { verified: filter.verified } : {}),
    });
    return parts.slice(0, filter.limit);
  }
  const all = await getLibrary(filter.limit * 2);
  return all
    .filter((p) => (filter.category ? p.category === filter.category : true))
    .filter((p) => (filter.verified !== undefined ? p.verified === filter.verified : true))
    .slice(0, filter.limit);
}

export async function findPartSpec(idOrName: string): Promise<{ part: PartSpec; how: string } | null> {
  const byId = await findPartById(idOrName);
  if (byId) return { part: byId, how: 'id' };
  const match = matchPart(idOrName, await getLibrary());
  return match ? { part: match, how: 'fuzzy' } : null;
}

export async function setPartVerified(id: string, verified: boolean): Promise<PartSpec | null> {
  return setVerified(id, verified);
}

export async function removePart(id: string): Promise<boolean> {
  return deletePart(id);
}

export interface HealthSnapshot {
  status: string;
  mongo: { ok: boolean; error: string | null };
  cadWorker: {
    ok: boolean;
    url: string;
    cadquery_version: string;
    freecad: boolean;
    error: string | null;
  };
  llm: { ok: boolean; model: string };
  search: { ok: boolean };
  uptime_s: number;
}

export async function healthSnapshot(): Promise<HealthSnapshot> {
  const [mongo, worker] = await Promise.all([
    pingDb().catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) })),
    workerHealth(4000).catch((e: unknown) => ({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      cadquery_version: 'unavailable',
      freecad: false,
    })),
  ]);

  const llmOk = env.ANTHROPIC_API_KEY.length > 0;
  const searchOk = env.TAVILY_API_KEY.length > 0;
  const status = mongo.ok && worker.ok && llmOk && searchOk ? 'ok' : 'degraded';

  return {
    status,
    mongo: { ok: mongo.ok, error: mongo.error ?? null },
    cadWorker: {
      ok: worker.ok,
      url: env.CAD_WORKER_URL,
      cadquery_version: worker.ok ? worker.cadquery_version : 'unavailable',
      freecad: worker.ok ? worker.freecad : false,
      error: worker.ok ? null : (worker as { error?: string }).error ?? 'unreachable',
    },
    llm: { ok: llmOk, model: env.ANTHROPIC_MODEL },
    search: { ok: searchOk },
    uptime_s: Math.round(process.uptime()),
  };
}

/** Exposed for the selftest: prove storage containment on artifact URLs. */
export function resolveArtifact(relativePath: string): string | null {
  const full = resolve(storageRoot, relativePath);
  if (!full.startsWith(resolve(storageRoot))) return null;
  return full;
}

export { relative };
