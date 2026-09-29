import { env } from '../env.js';
import { createLogger } from '../logger.js';
import { FetchError, fetchPageText, type SearchProvider, type SearchQuery, type SearchResult } from './search.js';

const log = createLogger('search:tavily');

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';

export interface TavilyOptions {
  apiKey?: string;
  endpoint?: string;
  maxResults?: number;
  topic?: 'general' | 'news';
  searchDepth?: 'basic' | 'advanced';
}

interface TavilyResponse {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    raw_content?: string | null;
    score?: number;
  }>;
  answer?: string | null;
}

export class TavilySearchProvider implements SearchProvider {
  readonly name = 'tavily';
  private readonly apiKey: string;
  private readonly endpoint: string;

  constructor(options: TavilyOptions = {}) {
    this.apiKey = options.apiKey ?? env.TAVILY_API_KEY;
    this.endpoint = options.endpoint ?? TAVILY_ENDPOINT;
    log.info('Tavily provider ready', { endpoint: this.endpoint });
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async search(query: SearchQuery): Promise<SearchResult[]> {
    const maxResults = query.maxResults ?? options_max(query);
    const body = {
      query: query.query,
      max_results: maxResults,
      search_depth: query.topic === 'news' ? 'basic' : 'advanced',
      include_raw_content: query.includeContent === true,
      include_answer: false,
      include_domains: undefined,
    };

    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new FetchError(
        `Tavily request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (res.status === 429) {
      throw new FetchError(
        'Tavily rate limit hit (429). Wait a minute or upgrade your plan at https://app.tavily.com/home',
        429,
      );
    }
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 400);
      throw new FetchError(`Tavily HTTP ${res.status}: ${detail}`, res.status);
    }

    const payload = (await res.json()) as TavilyResponse;
    const results = (payload.results ?? [])
      .filter((r): r is Required<Pick<typeof r, 'url'>> & typeof r => typeof r.url === 'string' && r.url.length > 0)
      .map((r) => ({
        title: r.title ?? r.url,
        url: r.url,
        snippet: (r.content ?? '').slice(0, 2000),
        score: typeof r.score === 'number' ? r.score : 0.5,
        ...(r.raw_content ? { raw_content: r.raw_content } : {}),
      }));

    log.debug('tavily search complete', { query: query.query, results: results.length });
    return results;
  }

  /** Fetch a page through the shared fetcher so the byte cap applies. */
  async fetchText(url: string): Promise<string> {
    const page = await fetchPageText(url, { maxBytes: env.MAX_FETCH_BYTES });
    return page.text;
  }
}

function options_max(q: SearchQuery): number {
  return q.maxResults ?? 6;
}
