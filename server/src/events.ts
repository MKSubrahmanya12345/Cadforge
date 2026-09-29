/** SSE event bus. One channel per project; subscribers get a replay on attach. */
export interface PipelineEvent {
  type: 'status' | 'log' | 'progress' | 'plan' | 'assembly' | 'artifacts' | 'done' | 'error';
  data: unknown;
}

type Subscriber = (event: PipelineEvent) => void;

const channels = new Map<string, Set<Subscriber>>();
const history = new Map<string, PipelineEvent[]>();
const HISTORY_LIMIT = 200;

export function subscribe(projectId: string, fn: Subscriber): () => void {
  let set = channels.get(projectId);
  if (!set) {
    set = new Set();
    channels.set(projectId, set);
  }
  set.add(fn);

  // Replay what already happened so a late subscriber sees full context.
  const past = history.get(projectId) ?? [];
  for (const event of past) {
    try {
      fn(event);
    } catch {
      // a dead subscriber must not break the replay for others
    }
  }

  return () => {
    const current = channels.get(projectId);
    if (!current) return;
    current.delete(fn);
    if (current.size === 0) {
      channels.delete(projectId);
      history.delete(projectId);
    }
  };
}

export function publish(projectId: string, event: PipelineEvent): void {
  const list = history.get(projectId);
  if (list) {
    list.push(event);
    if (list.length > HISTORY_LIMIT) list.splice(0, list.length - HISTORY_LIMIT);
  } else {
    history.set(projectId, [event]);
  }

  const subs = channels.get(projectId);
  if (!subs) return;
  for (const fn of subs) {
    try {
      fn(event);
    } catch {
      // ignore: one broken connection must not stop the pipeline
    }
  }
}

export function clear(projectId: string): void {
  channels.delete(projectId);
  history.delete(projectId);
}

export function subscriberCount(projectId: string): number {
  return channels.get(projectId)?.size ?? 0;
}
