import type { AssemblyItem, Artifacts, LogEntry, PartSpec, Plan, ProjectStatus, Vec3 } from '@cadforge/shared';
import type { LLMProvider } from '../providers/llm.js';
import type { SearchProvider } from '../providers/search.js';

/** Part store abstraction so the pipeline can run against a fake in tests. */
export interface PartStore {
  findByName(name: string): Promise<PartSpec | null>;
  listAll(): Promise<PartSpec[]>;
  listLibraryNames(): Promise<string[]>;
  upsert(spec: PartSpec): Promise<void>;
}

/**
 * Persistence hook. Production writes to Mongo; the e2e test supplies an
 * in-memory sink so the whole orchestrator can run without a database.
 */
export interface PipelineSink {
  appendLog(entry: LogEntry): Promise<void>;
  patch(fields: Record<string, unknown>): Promise<void>;
}

export interface PipelineContext {
  readonly projectId: string;
  readonly prompt: string;
  readonly llm: LLMProvider;
  readonly search: SearchProvider;
  readonly parts: PartStore;
  /**
   * Optional persistence. When omitted the orchestrator writes to Mongo, so
   * callers that already have a sink (the MCP bridge) can inject one and keep
   * every side effect in a single place.
   */
  readonly sink?: PipelineSink;
  log(level: LogEntry['level'], message: string): void;
  status(status: ProjectStatus): void;
  progress(pct: number, stage: string): void;
}

export interface GeneratedPart {
  instanceName: string;
  partId: string;
  spec: PartSpec;
  code: string;
  usedFallback: boolean;
  attempts: number;
  diff: string[];
}

export interface PipelineState {
  plan: Plan | null;
  specs: PartSpec[];
  assembly: AssemblyItem[];
  placements: Map<string, { position: Vec3; rotation: Vec3 }>;
  generated: GeneratedPart[];
  artifacts: Artifacts;
  scaleChecks: Array<{ label: string; expected: number; actual: number; ok: boolean; detail: string }>;
}
