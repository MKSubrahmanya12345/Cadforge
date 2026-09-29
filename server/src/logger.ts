type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: number = ORDER.info;
let pretty = true;

export function configureLogger(level: Level, isPretty = true): void {
  threshold = ORDER[level];
  pretty = isPretty;
}

function emit(level: Level, scope: string, message: string, meta?: unknown): void {
  if (ORDER[level] < threshold) return;
  const ts = new Date().toISOString();
  if (pretty) {
    const tag = level.toUpperCase().padEnd(5);
    const extra = meta === undefined ? '' : ` ${safeJson(meta)}`;
    console.log(`${ts} ${tag} [${scope}] ${message}${extra}`);
  } else {
    console.log(safeJson({ ts, level, scope, message, meta }));
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    return '"[unserializable]"';
  }
}

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, meta) => emit('debug', scope, m, meta),
    info: (m, meta) => emit('info', scope, m, meta),
    warn: (m, meta) => emit('warn', scope, m, meta),
    error: (m, meta) => emit('error', scope, m, meta),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export const log = createLogger('cadforge');
