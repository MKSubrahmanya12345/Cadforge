import Anthropic from '@anthropic-ai/sdk';
import { env } from '../env.js';
import { createLogger } from '../logger.js';
import { extractJson, type LLMProvider, type LLMRequest } from './llm.js';

const log = createLogger('llm:anthropic');

/** Trim the provider name for display, never log the key. */
function maskKey(key: string): string {
  if (key.length <= 8) return '***';
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(apiKey: string = env.ANTHROPIC_API_KEY, model: string = env.ANTHROPIC_MODEL) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
    this.model = model;
    log.info('Anthropic provider ready', { model, key: maskKey(apiKey) });
  }

  isConfigured(): boolean {
    return env.ANTHROPIC_API_KEY.length > 0;
  }

  async complete(request: LLMRequest): Promise<string> {
    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: request.maxTokens ?? 8000,
        temperature: request.temperature ?? 0,
        system: request.system,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      },
      request.signal ? { signal: request.signal } : undefined,
    );

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    if (text.length === 0) {
      throw new Error('Anthropic returned an empty response');
    }
    return text;
  }

  async json<T>(
    request: LLMRequest,
    validate: (raw: unknown) => T,
    retries: number = env.LLM_MAX_RETRIES,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= Math.max(1, retries); attempt += 1) {
      try {
        const raw = await this.complete({
          ...request,
          json: true,
          // Nudge the model harder toward pure JSON on retries.
          temperature: attempt === 1 ? request.temperature ?? 0 : 0,
          messages:
            attempt === 1
              ? request.messages
              : [
                  ...request.messages,
                  {
                    role: 'assistant',
                    content: '(previous response was rejected: ' + describe(lastError) + ')',
                  },
                  {
                    role: 'user',
                    content:
                      'Respond again with ONLY the JSON object. No prose, no markdown fences, ' +
                      'no explanation. Fix the validation error above.',
                  },
                ],
        });
        return validate(extractJson(raw));
      } catch (err) {
        lastError = err;
        log.warn('JSON attempt failed', { attempt, error: describe(err) });
      }
    }
    throw new Error(`LLM did not return valid JSON after ${retries} attempts: ${describe(lastError)}`);
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 600);
  return String(err).slice(0, 600);
}
