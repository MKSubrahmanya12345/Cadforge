import { useEffect, useRef } from 'react';
import { mergedLogs, STAGES, usePipeline } from '../state/pipeline';
import { formatTimestamp } from '@cadforge/shared';
import type { LogEntry, ProjectStatus, ProjectSummary } from '../types';
import './Sidebar.css';

const EXAMPLES = [
  'Arduino Uno with a 5mm LED on pin 13',
  'Uno + 220 ohm resistor and a 5mm LED',
  'Raspberry Pi 4B with a half-size breadboard',
  'Arduino Uno, HC-SR04, and 3 LEDs',
];

/** Map a project status onto the stage chip list, which uses stage ids. */
function stageForStatus(status: ProjectStatus): string {
  switch (status) {
    case 'planning':
      return 'plan';
    case 'resolving':
      return 'resolve';
    case 'researching':
      return 'research';
    case 'assembling':
      return 'assemble';
    case 'generating':
      return 'generate';
    case 'validating':
      return 'validate';
    case 'exporting':
      return 'export';
    case 'verifying':
      return 'verify';
    default:
      return status;
  }
}

export function Sidebar(): JSX.Element {
  const {
    projects,
    project,
    activeStage,
    submitting,
    loadingProjects,
    liveLogs,
    loadProjects,
    openProject,
    submit,
  } = usePipeline();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const logBodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const logs = mergedLogs(project, liveLogs);
  const currentStage = activeStage ?? (project ? stageForStatus(project.status) : null);
  const isRunning = project !== null && !['complete', 'failed'].includes(project.status);

  // Keep the newest log line in view.
  useEffect(() => {
    const el = logBodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.length]);

  const handleSubmit = async (): Promise<void> => {
    const el = textareaRef.current;
    const prompt = el?.value.trim() ?? '';
    if (prompt.length < 3) return;
    const id = await submit(prompt);
    if (id) {
      if (el) el.value = '';
      await openProject(id);
    }
  };

  const activeIndex = currentStage ? STAGES.findIndex((s) => s.id === currentStage) : -1;

  return (
    <aside className="sidebar" aria-label="Prompt, pipeline, and project history">
      <div className="prompt">
        <div className="prompt__label">
          <span className="eyebrow">Describe what to build</span>
          <span className="prompt__hint">Enter to run</span>
        </div>

        <textarea
          ref={textareaRef}
          className="textarea prompt__textarea"
          placeholder="Arduino Uno with a 5mm LED on pin 13 and a 220 ohm resistor"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleSubmit();
            }
          }}
          aria-label="Build request"
        />

        <div className="prompt__examples">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              className="prompt__example"
              onClick={() => {
                if (textareaRef.current) {
                  textareaRef.current.value = example;
                  textareaRef.current.focus();
                }
              }}
            >
              {example.length > 34 ? `${example.slice(0, 32)}…` : example}
            </button>
          ))}
        </div>

        <div className="prompt__actions">
          <span className="prompt__hint">Dimensions come from real datasheets.</span>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => void handleSubmit()}
            disabled={submitting}
          >
            {submitting ? <span className="spinner" /> : null}
            {submitting ? 'Starting' : 'Generate'}
          </button>
        </div>
      </div>

      {project ? (
        <StageChips project={project} currentStage={currentStage} activeIndex={activeIndex} />
      ) : null}

      {project ? (
        <div className="log">
          <div className="log__header">
            <span className="eyebrow">Pipeline log</span>
            {isRunning ? (
              <span className="chip">
                <span className="spinner" />
                {project.progress}%
              </span>
            ) : null}
          </div>
          <div className="log__body" ref={logBodyRef} role="log" aria-live="polite">
            {logs.length === 0 ? (
              <p className="log__empty">Waiting for the first stage to report…</p>
            ) : (
              logs.map((entry, i) => <LogLine key={`${entry.ts}-${i}`} entry={entry} />)
            )}
          </div>
        </div>
      ) : null}

      <div className="history">
        <div className="history__header">
          <span className="eyebrow">Projects</span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void loadProjects()}
            disabled={loadingProjects}
          >
            {loadingProjects ? <span className="spinner" /> : null}
            Refresh
          </button>
        </div>
        <div className="history__list">
          {projects.length === 0 && !loadingProjects ? (
            <p className="empty">
              No projects yet.
              <br />
              Describe something above to generate your first true-scale model.
            </p>
          ) : (
            projects.map((p) => (
              <ProjectRow
                key={p._id}
                project={p}
                active={p._id === project?._id}
                onOpen={() => void openProject(p._id)}
              />
            ))
          )}
        </div>
      </div>
    </aside>
  );
}

function StageChips({
  project,
  currentStage,
  activeIndex,
}: {
  project: { status: string; progress: number };
  currentStage: string | null;
  activeIndex: number;
}): JSX.Element {
  const failed = project.status === 'failed';
  return (
    <div className="stages">
      <div className="stages__header">
        <span className="eyebrow">Pipeline</span>
        <span className="chip">{project.status}</span>
      </div>
      <div
        className="stages__bar"
        role="progressbar"
        aria-valuenow={project.progress}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="stages__fill"
          style={{
            width: `${project.progress}%`,
            background: failed ? 'var(--err)' : project.status === 'complete' ? 'var(--ok)' : undefined,
          }}
        />
      </div>
      <div className="stages__chips">
        {STAGES.map((stage, i) => {
          const active = stage.id === currentStage;
          const done = !failed && activeIndex > i;
          const skipped = failed && !done && i > activeIndex;
          const cls = [
            'stage-chip',
            active ? 'stage-chip--active' : '',
            done ? 'stage-chip--done' : '',
            skipped ? 'stage-chip--skipped' : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <span key={stage.id} className={cls} title={active ? `${stage.label} (running)` : stage.label}>
              <span className="stage-chip__dot" />
              {stage.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function LogLine({ entry }: { entry: LogEntry }): JSX.Element {
  return (
    <div className={`log__line log__line--${entry.level}`}>
      <span className="log__time">{formatTimestamp(entry.ts)}</span>
      <span className="log__stage">{entry.stage}</span>
      <span className="log__msg">{entry.message}</span>
    </div>
  );
}

function ProjectRow({
  project,
  active,
  onOpen,
}: {
  project: ProjectSummary;
  active: boolean;
  onOpen: () => void;
}): JSX.Element {
  const running = !['complete', 'failed'].includes(project.status);
  const dotClass = running
    ? 'status-dot status-dot--running'
    : project.status === 'complete'
      ? 'status-dot status-dot--complete'
      : 'status-dot status-dot--failed';

  return (
    <button
      type="button"
      className={`history__item${active ? ' history__item--active' : ''}`}
      onClick={onOpen}
    >
      <span className="history__prompt">{project.prompt}</span>
      <span className="history__meta">
        <span className={dotClass} />
        {project.status}
        {running ? ` · ${project.progress}%` : ''}
        <span>· {formatTimestamp(project.createdAt)}</span>
      </span>
    </button>
  );
}
