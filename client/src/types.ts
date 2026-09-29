/** Types the API returns but that are not part of the shared Zod schemas. */

export interface ScaleCheck {
  label: string;
  expected: number;
  actual: number;
  ok: boolean;
  detail: string;
}

export type ProjectStatus =
  | 'queued'
  | 'planning'
  | 'resolving'
  | 'researching'
  | 'assembling'
  | 'generating'
  | 'validating'
  | 'exporting'
  | 'verifying'
  | 'complete'
  | 'failed';

export interface LogEntry {
  ts: string;
  stage: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
}

export interface AssemblyItem {
  partId: string;
  instanceName: string;
  placement: {
    anchorRef?: { targetInstance: string; anchorName: string };
    offset_mm: { x: number; y: number; z: number };
    rotation_deg: { x: number; y: number; z: number };
  };
  resolvedPosition_mm?: { x: number; y: number; z: number };
}

export interface Plan {
  parts: Array<{ name: string; quantity: number; role: string }>;
  relations: Array<{ a: string; b: string; description: string }>;
}

export interface Artifacts {
  step: string | null;
  glb: string | null;
  stl: string | null;
  fcstd: string | null;
}

export interface Project {
  _id: string;
  prompt: string;
  status: ProjectStatus;
  plan: Plan | null;
  assembly: AssemblyItem[];
  artifacts: Artifacts;
  logs: LogEntry[];
  scaleChecks: ScaleCheck[];
  progress: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummary {
  _id: string;
  prompt: string;
  status: ProjectStatus;
  progress: number;
  artifacts: Artifacts;
  error: string | null;
  createdAt: string;
}

export interface Part {
  id: string;
  name: string;
  category: string;
  aliases: string[];
  bbox_mm: { x: number; y: number; z: number };
  features: Array<{
    type: string;
    name: string;
    position_mm: { x: number; y: number; z: number };
    dims_mm: Record<string, number>;
    note?: string;
  }>;
  anchors: Array<{
    name: string;
    position_mm: { x: number; y: number; z: number };
    normal?: { x: number; y: number; z: number };
  }>;
  pitch_mm?: number;
  material?: string;
  color_hex?: string;
  sources: Array<{
    url: string;
    title: string;
    extracted_fields: Array<{ field: string; value: string; conflict?: string }>;
  }>;
  confidence: number;
  verified: boolean;
  origin: 'seed' | 'research' | 'human';
  notes?: string;
  issues?: Array<{ severity: 'error' | 'warning'; path: string; message: string }>;
}

export interface Health {
  status: 'ok' | 'degraded';
  mongo: { ok: boolean; error: string | null };
  cadWorker: {
    ok: boolean;
    url: string;
    cadquery_version: string;
    freecad: boolean;
    error: string | null;
  };
  llm: { ok: boolean; provider: string; model: string; key_present: boolean };
  search: { ok: boolean; provider: string; key_present: boolean };
  storage_dir: string;
  uptime_s: number;
}

export type Format = 'step' | 'glb' | 'stl' | 'fcstd';
