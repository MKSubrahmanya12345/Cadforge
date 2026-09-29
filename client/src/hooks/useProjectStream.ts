import { useEffect, useRef } from 'react';
import { usePipeline } from '../state/pipeline';
import type { ProjectStatus } from '../types';

/**
 * Subscribe to GET /api/projects/:id/events and fold the SSE stream into the
 * store.
 *
 * EventSource reconnects on its own, so the only thing this hook has to get
 * right is closing the stream when the project changes. The server replays its
 * event history to any new subscriber, so a late or dropped connection still
 * ends up with the full log.
 */
export function useProjectStream(projectId: string | null): void {
  const setProject = usePipeline((s) => s.setProject);
  const appendLog = usePipeline((s) => s.appendLog);
  const setActiveStage = usePipeline((s) => s.setActiveStage);
  const setError = usePipeline((s) => s.setError);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!projectId) {
      sourceRef.current?.close();
      sourceRef.current = null;
      return;
    }

    const source = new EventSource(`/api/projects/${projectId}/events`);
    sourceRef.current = source;

    const onStatus = (event: MessageEvent<string>) => {
      try {
        const data = JSON.parse(event.data) as { status: ProjectStatus };
        if (data.status === 'complete' || data.status === 'failed') {
          setActiveStage(null);
          source.close();
        } else {
          setActiveStage(data.status);
        }
      } catch {
        // A malformed frame is not worth surfacing; the final fetch corrects state.
      }
    };

    const onLog = (event: MessageEvent<string>) => {
      try {
        appendLog(JSON.parse(event.data) as Parameters<typeof appendLog>[0]);
      } catch {
        // ignore
      }
    };

    const onProgress = (event: MessageEvent<string>) => {
      try {
        const data = JSON.parse(event.data) as { stage: string };
        setActiveStage(data.stage);
      } catch {
        // ignore
      }
    };

    const onDone = () => {
      setActiveStage(null);
      source.close();
      // The artifacts only exist server-side once the run is done, so refetch.
      void usePipeline.getState().openProject(projectId);
    };

    const onError = () => {
      // EventSource fires 'error' on normal close too, so only report it if the
      // pipeline is genuinely still unfinished.
      const state = usePipeline.getState();
      if (state.project && !['complete', 'failed'].includes(state.project.status)) {
        setError('Lost the connection to the pipeline. Reload the project to catch up.');
      }
    };

    source.addEventListener('status', onStatus as EventListener);
    source.addEventListener('log', onLog as EventListener);
    source.addEventListener('progress', onProgress as EventListener);
    source.addEventListener('done', onDone as EventListener);
    source.addEventListener('error', onError as EventListener);

    return () => {
      source.close();
      sourceRef.current = null;
    };
  }, [projectId, setProject, appendLog, setActiveStage, setError]);
}
