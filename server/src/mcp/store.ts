/**
 * Storage for agent-built models.
 *
 * The LLM pipeline stores its projects in Mongo. An agent-driven build does not
 * need to: nothing queries a model after it is generated except the download
 * links, and those are path-based, not id-based. Keeping this in memory means
 * CADForge can run with a database that is empty, read-only, or entirely absent
 * and still build models.
 */
import { randomUUID } from 'node:crypto';
import type { AssemblyItem, PartSpec } from '@cadforge/shared';

export interface AgentModel {
  id: string;
  name: string;
  createdAt: string;
  parts: PartSpec[];
  assembly: Array<AssemblyItem & { resolvedPosition_mm: { x: number; y: number; z: number } }>;
}

const models = new Map<string, AgentModel>();
const MODEL_LIMIT = 200;

export async function createProjectDoc(input: {
  prompt: string;
  parts: PartSpec[];
  assembly: AgentModel['assembly'];
  name: string;
}): Promise<string> {
  // Bounded so a long-lived server cannot accumulate models forever. Models are
  // disposable — the caller has already downloaded (or will download) the file.
  if (models.size >= MODEL_LIMIT) {
    const oldest = models.keys().next().value;
    if (oldest !== undefined) models.delete(oldest);
  }

  const id = randomUUID().replace(/-/g, '').slice(0, 24);
  models.set(id, {
    id,
    name: input.name,
    createdAt: new Date().toISOString(),
    parts: input.parts,
    assembly: input.assembly,
  });
  return id;
}

export function getModel(id: string): AgentModel | null {
  return models.get(id) ?? null;
}

export function listModels(): AgentModel[] {
  return [...models.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function deleteModel(id: string): boolean {
  return models.delete(id);
}

export function modelCount(): number {
  return models.size;
}
