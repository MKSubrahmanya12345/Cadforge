import type { Artifacts, Format, Health, Part, Project, ProjectSummary } from './types';

/**
 * In development Vite proxies /api and /files to the Express server, so a
 * relative base works. A build deployed separately sets VITE_API_URL.
 */
const BASE = (import.meta.env['VITE_API_URL'] as string | undefined)?.replace(/\/$/, '') ?? '';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly issues?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (err) {
    throw new ApiError(
      0,
      `Could not reach the CADForge API. Is the server running on ${
        BASE === '' ? window.location.origin : BASE
      }? (${err instanceof Error ? err.message : 'network error'})`,
    );
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let body: unknown;
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    throw new ApiError(res.status, `The API returned a non-JSON response: ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    const err = (body as { error?: { message?: string; issues?: Array<{ path: string; message: string }> } })?.error;
    throw new ApiError(res.status, err?.message ?? `Request failed with HTTP ${res.status}`, err?.issues);
  }
  return body as T;
}

export const api = {
  health: () => request<Health>('/api/health'),

  listProjects: () => request<ProjectSummary[]>('/api/projects'),

  getProject: (id: string) => request<Project>(`/api/projects/${id}`),

  createProject: (prompt: string) =>
    request<{ projectId: string; status: string }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    }),

  deleteProject: (id: string) => request<void>(`/api/projects/${id}`, { method: 'DELETE' }),

  listParts: (params?: { q?: string; category?: string; verified?: boolean }) => {
    const search = new URLSearchParams();
    if (params?.q) search.set('q', params.q);
    if (params?.category) search.set('category', params.category);
    if (params?.verified !== undefined) search.set('verified', String(params.verified));
    const qs = search.toString();
    return request<Part[]>(`/api/parts${qs ? `?${qs}` : ''}`);
  },

  getPart: (id: string) => request<Part>(`/api/parts/${id}`),

  verifyPart: (id: string, verified = true) =>
    request<Part>(`/api/parts/${id}/verify`, {
      method: 'POST',
      body: JSON.stringify({ verified }),
    }),

  /**
   * URL for a format. The API returns storage-relative paths; the /files mount
   * serves them, so this is a plain same-origin URL in dev and an absolute one
   * when the client is deployed separately.
   */
  fileUrl: (projectId: string, format: Format): string => {
    return `${BASE}/files/${projectId}/assembly.${format === 'fcstd' ? 'FCStd' : format}`;
  },

  perPartUrl: (projectId: string, instance: string, format: 'step' | 'glb'): string => {
    return `${BASE}/files/${projectId}/parts/${instance}.${format}`;
  },

  /** Formats the server says it produced. */
  availableFormats: (artifacts: Artifacts): Format[] =>
    (['step', 'glb', 'stl', 'fcstd'] as const).filter((f) => artifacts[f] !== null),
};
