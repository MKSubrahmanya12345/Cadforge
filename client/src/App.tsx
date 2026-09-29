import { useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { Sidebar } from './components/Sidebar';
import { RightPanel } from './components/RightPanel';
import { Viewport } from './components/Viewport';
import { usePipeline } from './state/pipeline';
import { useProjectStream } from './hooks/useProjectStream';
import type { Health } from './types';
import './App.css';

export function App(): JSX.Element {
  const { project, error, setError, loadProjects } = usePipeline();
  const [health, setHealth] = useState<Health | null>(null);
  const [healthChecked, setHealthChecked] = useState(false);

  useProjectStream(project?._id ?? null);

  // Poll health so a dead worker or a missing key is visible immediately rather
  // than at the end of a three-minute run.
  useEffect(() => {
    let cancelled = false;

    const check = async (): Promise<void> => {
      try {
        const next = await api.health();
        if (!cancelled) setHealth(next);
      } catch {
        if (!cancelled) setHealth(null);
      } finally {
        if (!cancelled) setHealthChecked(true);
      }
    };

    void check();
    const timer = setInterval(() => void check(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // Refresh the list when a run finishes, so a new project appears in history.
  useEffect(() => {
    if (project && ['complete', 'failed'].includes(project.status)) {
      void loadProjects();
    }
  }, [project?.status, project, loadProjects]);

  return (
    <div className="app">
      <div className="app__main">
        <StatusBar health={health} checked={healthChecked} />

        {error ? (
          <div className="banner" role="alert">
            <span>{error}</span>
            <button type="button" className="btn btn--sm" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        ) : null}

        <div className="app__content">
          <Sidebar />
          <Viewport />
          <RightPanel />
        </div>
      </div>
    </div>
  );
}

function StatusBar({ health, checked }: { health: Health | null; checked: boolean }): JSX.Element {
  const dot = (state: 'ok' | 'bad' | 'warn' | 'unknown'): string =>
    `status-bar__dot status-bar__dot--${state}`;

  return (
    <header className="status-bar">
      <div className="status-bar__group">
        <span className="status-bar__item">
          <span className="status-bar__item" style={{ fontWeight: 700, color: 'var(--text-0)' }}>
            CADForge
          </span>
        </span>
        <span className="status-bar__item" title="MongoDB connection">
          <span className={dot(health ? (health.mongo.ok ? 'ok' : 'bad') : 'unknown')} />
          mongo
        </span>
        <span className="status-bar__item" title="The CadQuery worker (Python)">
          <span className={dot(health ? (health.cadWorker.ok ? 'ok' : 'bad') : 'unknown')} />
          worker
          {health?.cadWorker.ok ? (
            <span className="status-bar__detail">
              cq {health.cadWorker.cadquery_version}
              {health.cadWorker.freecad ? ' · fcstd' : ''}
            </span>
          ) : null}
        </span>
        <span className="status-bar__item" title="Anthropic API key">
          <span className={dot(health ? (health.llm.key_present ? 'ok' : 'bad') : 'unknown')} />
          llm
        </span>
        <span className="status-bar__item" title="Tavily API key">
          <span className={dot(health ? (health.search.key_present ? 'ok' : 'bad') : 'unknown')} />
          search
        </span>
      </div>

      <div className="status-bar__group">
        {checked && !health ? (
          <span className="status-bar__item" style={{ color: 'var(--err)' }}>
            API unreachable
          </span>
        ) : null}
        {health && !health.cadWorker.ok ? (
          <span
            className="status-bar__item status-bar__detail"
            title={health.cadWorker.error ?? undefined}
          >
            worker unreachable — start it in cad-worker/
          </span>
        ) : null}
        {health && health.llm.key_present === false ? (
          <span className="status-bar__item" style={{ color: 'var(--warn)' }}>
            ANTHROPIC_API_KEY missing
          </span>
        ) : null}
        {health && health.search.key_present === false ? (
          <span className="status-bar__item" style={{ color: 'var(--warn)' }}>
            TAVILY_API_KEY missing
          </span>
        ) : null}
      </div>
    </header>
  );
}

export { ApiError };
