import type { PartSpec } from '@cadforge/shared';
import type { LLMProvider, LLMRequest } from '../providers/llm.js';
import type { SearchProvider, SearchQuery, SearchResult } from '../providers/search.js';
import { SEED_PARTS } from '../seed/parts.js';
import type { PartStore } from '../pipeline/types.js';

/**
 * An LLM provider that returns deterministic, hand-written answers.
 *
 * This lets the e2e test exercise the real pipeline (planning, resolution,
 * anchor placement, codegen, worker export) with zero network calls. If the
 * pipeline ever asks for something the mock does not know, it throws loudly
 * rather than silently returning plausible garbage.
 */
export class ScriptedLLM implements LLMProvider {
  readonly name = 'scripted';
  readonly calls: Array<{ system: string; user: string }> = [];

  constructor(
    private readonly handlers: Array<{
      match: (system: string, user: string) => boolean;
      respond: (system: string, user: string) => unknown;
    }>,
  ) {}

  isConfigured(): boolean {
    return true;
  }

  async complete(request: LLMRequest): Promise<string> {
    const system = request.system;
    const user = request.messages.map((m) => m.content).join('\n\n');
    this.calls.push({ system, user });
    for (const handler of this.handlers) {
      if (handler.match(system, user)) {
        return JSON.stringify(handler.respond(system, user));
      }
    }
    throw new Error(
      `ScriptedLLM has no handler for this call. system="${system.slice(0, 80)}" user="${user.slice(0, 160)}"`,
    );
  }

  async json<T>(request: LLMRequest, validate: (raw: unknown) => T): Promise<T> {
    const raw = await this.complete(request);
    return validate(JSON.parse(raw));
  }
}

export class MockSearchProvider implements SearchProvider {
  readonly name = 'mock';
  readonly queries: string[] = [];

  constructor(private readonly results: SearchResult[] = []) {}

  isConfigured(): boolean {
    return true;
  }

  async search(query: SearchQuery): Promise<SearchResult[]> {
    this.queries.push(query.query);
    return this.results.slice(0, query.maxResults ?? this.results.length);
  }
}

/** In-memory part store backed by the seed library. */
export class MemoryPartStore implements PartStore {
  private readonly parts = new Map<string, PartSpec>();

  constructor(initial: PartSpec[] = SEED_PARTS) {
    for (const p of initial) this.parts.set(p.id, p);
  }

  async findByName(name: string): Promise<PartSpec | null> {
    const { matchPart } = await import('@cadforge/shared');
    return matchPart(name, [...this.parts.values()], 0.9);
  }

  async listAll(): Promise<PartSpec[]> {
    return [...this.parts.values()];
  }

  async listLibraryNames(): Promise<string[]> {
    return [...this.parts.values()].map((p) => p.name);
  }

  async upsert(spec: PartSpec): Promise<void> {
    this.parts.set(spec.id, spec);
  }

  get(id: string): PartSpec | null {
    return this.parts.get(id) ?? null;
  }

  all(): PartSpec[] {
    return [...this.parts.values()];
  }
}
