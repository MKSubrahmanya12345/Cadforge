import { create } from 'zustand';
import type { Project, ProjectSummary } from '../types';
import { api, ApiError } from '../api';

/**
 * Pipeline stage order. Progress is derived from which stage is active, because
 * the server reports a single percentage for the whole run.
 */
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

const TERMINAL: ReadonlySet<string> = new Set(['complete', 'failed']);

interface PipelineState {
  projects: ProjectSummary[];
  project: Project | null;
  activeStage: string | null;
  loadingProjects: boolean;
  loadingProject: boolean;
  submitting: boolean;
  error: string | null;
  /** Live log lines streamed over SSE, newest last. */
  liveLogs: Project['logs'];

  loadProjects: () => Promise<void>;
  openProject: (id: string) => Promise<void>;
  submit: (prompt: string) => Promise<string | null>;
  close: () => void;
  setProject: (project: Project) => void;
  appendLog: (entry: Project['logs'][number]) => void;
  setActiveStage: (stage: string | null) => void;
  setError: (message: string | null) => void;
  dismissProject: () => void;
}

export const usePipeline = create<PipelineState>((set, get) => ({
  projects: [],
  project: null,
  activeStage: null,
  loadingProjects: false,
  loadingProject: false,
  submitting: false,
  error: null,
  liveLogs: [],

  async loadProjects() {
    set({ loadingProjects: true });
    try {
      const projects = await api.listProjects();
      set({ projects, loadingProjects: false, error: null });
    } catch (err) {
      set({
        loadingProjects: false,
        error: err instanceof ApiError ? err.message : 'Could not load the project list',
      });
    }
  },

  async openProject(id) {
    set({ loadingProject: true, error: null, liveLogs: [] });
    try {
      const project = await api.getProject(id);
      set({
        project,
        loadingProject: false,
        activeStage: TERMINAL.has(project.status) ? null : project.status,
        liveLogs: project.logs,
      });
    } catch (err) {
      set({
        loadingProject: false,
        error: err instanceof ApiError ? err.message : 'Could not load that project',
      });
    }
  },

  async submit(prompt) {
    set({ submitting: true, error: null });
    try {
      const { projectId } = await api.createProject(prompt);
      set({ submitting: false });
      await get().loadProjects();
      return projectId;
    } catch (err) {
      set({
        submitting: false,
        error: err instanceof ApiError ? err.message : 'Could not start the pipeline',
      });
      return null;
    }
  },

  close() {
    set({ project: null, activeStage: null, liveLogs: [] });
  },

  setProject(project) {
    set({ project, activeStage: TERMINAL.has(project.status) ? null : project.status });
  },

  appendLog(entry) {
    set((state) => ({ liveLogs: [...state.liveLogs, entry] }));
  },

  setActiveStage(stage) {
    set({ activeStage: stage });
  },

  setError(message) {
    set({ error: message });
  },

  dismissProject() {
    set({ project: null, activeStage: null, liveLogs: [] });
  },
}));

/** Merge the streamed logs with whatever the last fetch returned. */
export function mergedLogs(project: Project | null, live: Project['logs']): Project['logs'] {
  if (!project) return live;
  const byKey = new Map<string, Project['logs'][number]>();
  for (const entry of [...project.logs, ...live]) {
    byKey.set(`${entry.ts}|${entry.stage}|${entry.message}`, entry);
  }
  return [...byKey.values()];
}
