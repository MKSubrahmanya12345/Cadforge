/**
 * Web search provider interface. Tavily is the default implementation; any
 * other search backend can be dropped in behind the same interface.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** 0..1, provider-supplied relevance. */
  score: number;
  raw_content?: string;
}

export interface SearchQuery {
  query: string;
  maxResults?: number;
  /** Tavily topic. */
  topic?: 'general' | 'news';
  /** Include the page body in raw_content (costs more credits). */
  includeContent?: boolean;
}

export interface SearchProvider {
  readonly name: string;
  search(query: SearchQuery): Promise<SearchResult[]>;
  isConfigured(): boolean;
}

/** Cap on a fetched page, to bound memory and LLM token spend. */
export const FETCH_TIMEOUT_MS = 15_000;
export const DEFAULT_FETCH_LIMIT = 400_000;

export interface FetchedPage {
  url: string;
  contentType: string;
  text: string;
  bytes: number;
  truncated: boolean;
}

export class FetchError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

function isPdf(url: string, contentType: string): boolean {
  return contentType.includes('pdf') || url.toLowerCase().endsWith('.pdf');
}

/** Extract text from a PDF using pdf-parse (dynamic so tests need no dep). */
async function parsePdf(bytes: Uint8Array): Promise<string> {
  const { default: pdfParse } = await import('pdf-parse');
  const buf = Buffer.from(bytes);
  const result = await pdfParse(buf);
  return typeof result === 'string' ? result : result.text;
}

/** Rough HTML -> text. Enough for datasheet pages; never throws. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|br)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Fetch a URL and return plain text, honouring a byte cap and a timeout.
 * Redirects are followed manually so a redirect cannot escape the byte budget.
 */
export async function fetchPageText(
  url: string,
  opts: { maxBytes?: number; timeoutMs?: number; maxRedirects?: number } = {},
): Promise<FetchedPage> {
  const maxBytes = opts.maxBytes ?? DEFAULT_FETCH_LIMIT;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? 5;

  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      throw new FetchError(`invalid URL: ${current}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new FetchError(`unsupported protocol: ${parsed.protocol}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(current, {
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          'user-agent': 'CADForge/1.0 (datasheet research bot)',
          accept: 'text/html,application/pdf,text/plain;q=0.9,*/*;q=0.8',
        },
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) throw new FetchError(`redirect without location (${res.status})`, res.status);
        current = new URL(location, current).toString();
        continue;
      }

      if (!res.ok) {
        throw new FetchError(`HTTP ${res.status} for ${current}`, res.status);
      }

      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
      const declaredLength = Number(res.headers.get('content-length') ?? '0');
      if (declaredLength > maxBytes) {
        throw new FetchError(
          `content-length ${declaredLength} exceeds the ${maxBytes} byte limit`,
          413,
        );
      }

      const buf = new Uint8Array(await res.arrayBuffer());
      const truncated = buf.byteLength > maxBytes;
      const slice = truncated ? buf.subarray(0, maxBytes) : buf;

      const text = isPdf(current, contentType)
        ? await parsePdf(slice)
        : contentType.includes('html') || contentType.includes('xml') || slice.byteLength > 0
          ? htmlToText(new TextDecoder('utf-8').decode(slice))
          : '';

      return {
        url: current,
        contentType,
        text,
        bytes: slice.byteLength,
        truncated,
      };
    } catch (err) {
      if (err instanceof FetchError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new FetchError(`timed out after ${timeoutMs}ms: ${current}`);
      }
      throw new FetchError(`fetch failed for ${current}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new FetchError(`too many redirects starting at ${url}`);
}
