/**
 * LLM provider interface.
 *
 * The pipeline never imports the Anthropic SDK directly; it goes through this
 * interface so the backend is swappable (and mockable in tests).
 */

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LLMRequest {
  system: string;
  messages: LLMMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Ask the provider for a JSON object; some providers support this natively. */
  json?: boolean;
  signal?: AbortSignal;
}

export interface LLMProvider {
  readonly name: string;
  complete(request: LLMRequest): Promise<string>;
  /** JSON mode with Zod validation and bounded retries on parse failure. */
  json<T>(request: LLMRequest, validate: (raw: unknown) => T, retries?: number): Promise<T>;
  isConfigured(): boolean;
}

/**
 * Shared JSON extraction: models sometimes wrap JSON in prose or a code fence
 * despite instructions. Pull out the first balanced object or array.
 */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fence?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    // fall through to brace scanning
  }

  const start = candidate.search(/[[{]/);
  if (start === -1) {
    throw new Error('no JSON object or array found in model output');
  }
  const open = candidate[start] as '[' | '{';
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < candidate.length; i += 1) {
    const ch = candidate[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(candidate.slice(start, i + 1));
      }
    }
  }
  throw new Error('model output contained an unterminated JSON structure');
}
