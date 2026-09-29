export const STAGES = [
  { id: 'plan', label: 'Plan' },
  { id: 'resolve', label: 'Resolve' },
  { id: 'research', label: 'Research' },
  { id: 'assemble', label: 'Assemble' },
  { id: 'generate', label: 'Generate' },
  { id: 'validate', label: 'Validate' },
  { id: 'export', label: 'Export' },
  { id: 'verify', label: 'Verify' },
] as const;

export type StageId = (typeof STAGES)[number]['id'];
export const STAGE_IDS: readonly StageId[] = STAGES.map((s) => s.id);

export function stageLabel(id: string): string {
  return STAGES.find((s) => s.id === id)?.label ?? id;
}

const CONFIDENCE_COLOR = (c: number): string => {
  if (c >= 0.9) return '#3ddc97';
  if (c >= 0.7) return '#ffd166';
  if (c >= 0.5) return '#ff9f1c';
  return '#ef476f';
};

export function confidenceColor(c: number): string {
  return CONFIDENCE_COLOR(c);
}

export function confidenceLabel(c: number): string {
  if (c >= 0.9) return 'high';
  if (c >= 0.7) return 'medium';
  if (c >= 0.5) return 'low';
  return 'very low';
}

export function formatDims(d: { x: number; y: number; z: number }): string {
  return `${d.x.toFixed(2)} × ${d.y.toFixed(2)} × ${d.z.toFixed(2)} mm`;
}

export function formatTimestamp(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  return t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
