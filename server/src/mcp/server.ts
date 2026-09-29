/**
 * MCP transport for CADForge.
 *
 * Streamable HTTP, stateless: every POST builds a fresh Server + transport bound
 * to the authenticated caller, so there is no session to expire and no shared
 * mutable state between requests. That is what makes the endpoint safe to put
 * behind a CDN or a platform that scales to many instances.
 *
 * Auth is a single bearer token (MCP_API_KEY). CADForge has no user accounts, so
 * there is no per-user ownership to resolve — the key is instance-wide, which is
 * why the rate limit is not optional.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { Router } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { env } from '../env.js';
import { createLogger } from '../logger.js';
import { advertisedTools, getMcpTool, type McpToolResult } from './tools.js';

const log = createLogger('mcp');

/** Per-key request budget. Generations are expensive, so writes cost more. */
const READ_LIMIT = 120;
const WRITE_LIMIT = 30;

interface Bucket {
  read: number;
  write: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export function mcpConfigured(): boolean {
  return env.MCP_API_KEY.length > 0 || env.MCP_AUTH_DISABLED;
}

export function mcpAuthMode(): 'bearer' | 'none' {
  return env.MCP_AUTH_DISABLED ? 'none' : 'bearer';
}

function keysMatch(presented: string, expected: string): boolean {
  const left = createHash('sha256').update(presented).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

/**
 * Resolve the caller from the Authorization header.
 * Returns a Response (ready to send) when the request must be refused.
 */
export function authorize(
  req: ExpressRequest,
): { ok: true } | { ok: false; status: number; code: string; message: string } {
  if (!mcpConfigured()) {
    return {
      ok: false,
      status: 503,
      code: 'mcp_not_configured',
      message:
        'MCP is not configured. Set MCP_API_KEY in the server .env and restart, then reload the MCP client.',
    };
  }

  if (mcpAuthMode() === 'none') {
    return { ok: true };
  }

  const header = req.headers.authorization ?? '';
  const [scheme, presented] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !presented) {
    return {
      ok: false,
      status: 401,
      code: 'unauthorized',
      message: 'Send "Authorization: Bearer <MCP_API_KEY>" with the MCP_API_KEY from the server .env.',
    };
  }
  if (!keysMatch(presented, env.MCP_API_KEY)) {
    return { ok: false, status: 401, code: 'unauthorized', message: 'That bearer key is not valid.' };
  }
  return { ok: true };
}

export interface RateVerdict {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
}

/** Counted per key when auth is on, per IP otherwise. */
export function takeQuota(key: string, isWrite: boolean): RateVerdict {
  const now = Date.now();
  const windowMs = 60_000;
  const max = isWrite ? WRITE_LIMIT : READ_LIMIT;
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { read: 0, write: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  const counter = isWrite ? 'write' : 'read';
  bucket[counter] += 1;
  if (bucket[counter] > max) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000),
      remaining: 0,
    };
  }
  return {
    allowed: true,
    retryAfterSeconds: 0,
    remaining: max - bucket[counter],
  };
}

/**
 * The optional LLM pipeline (PLAN / RESEARCH / GENERATE) needs both keys. The
 * core CAD tools do not, which is the point: an agent drives the model and we
 * only build it.
 */
function llmPipelineEnabled(): boolean {
  return env.ANTHROPIC_API_KEY.length > 0 && env.TAVILY_API_KEY.length > 0;
}

export function buildMcpServer(): Server {
  const server = new Server(
    { name: 'cadforge', version: '2.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'CADForge builds true-scale CAD models from parts you specify. It is a CAD service, not an agent: ' +
        'YOU do the research, the planning, and the choosing of parts. CADForge takes explicit ' +
        'millimetre dimensions and turns them into real geometry at exactly that scale, then checks the ' +
        'built solid against your numbers and exports STEP + GLB + STL.\n\n' +
        'How to use it:\n' +
        '1. Research the real dimensions yourself (web search, datasheets). Prefer manufacturer drawings.\n' +
        '2. Call build_cad_model with each part\'s bbox_mm, features, and anchors in millimetres.\n' +
        '3. Read the verification block it returns. It reports the size measured off the built solid, not ' +
        'the numbers you sent, so a disagreement means a dimension is wrong.\n' +
        '4. Download from the URLs it returns. STEP is the source of truth; GLB is metres and Y-up for a ' +
        'web viewer; STL is millimetres and Z-up.\n\n' +
        'Real parts are not round numbers. An Arduino Uno is 68.58 x 53.34 x 1.6 mm, not 70 x 50 x 2. A ' +
        '5mm LED is a 5.0 mm dome. Using round numbers is how a model ends up 1000x out, and because ' +
        'nothing here second-guesses you, that error reaches the file.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: advertisedTools(llmPipelineEnabled()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (call) => {
    const tool = getMcpTool(call.params.name);
    if (!tool) {
      return {
        content: [{ type: 'text' as const, text: `Unknown tool: ${call.params.name}` }],
        isError: true,
      };
    }
    const started = Date.now();
    try {
      const result = await tool.run((call.params.arguments ?? {}) as Record<string, unknown>);
      log.info('tool call', {
        tool: tool.name,
        ms: Date.now() - started,
        isError: result.isError === true,
      });
      return result as CallToolResult;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('tool threw', { tool: tool.name, message });
      const failure: McpToolResult = {
        content: [{ type: 'text', text: message }],
        isError: true,
      };
      return failure as CallToolResult;
    }
  });

  return server;
}

const MCP_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, MCP-Protocol-Version, mcp-session-id, Last-Event-ID',
  'Access-Control-Expose-Headers': 'mcp-session-id',
};

export const mcpRouter: Router = Router();

/**
 * POST /mcp — JSON-RPC over streamable HTTP.
 * GET is rejected: without session state there is no stream to open.
 */
mcpRouter.post('/mcp', async (req, res) => {
  for (const [k, v] of Object.entries(MCP_HEADERS)) res.setHeader(k, v);

  const auth = authorize(req);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.code, detail: auth.message });
    return;
  }

  // The quota is taken before any work, keyed on the presented token so one
  // holder cannot lock out another behind the same NAT.
  const quotaKey = env.MCP_API_KEY.length > 0 ? createHash('sha256').update(env.MCP_API_KEY).digest('hex') : (req.ip ?? 'unknown');
  const verdict = takeQuota(quotaKey, false);
  if (!verdict.allowed) {
    res.setHeader('Retry-After', String(verdict.retryAfterSeconds));
    res.status(429).json({
      error: 'rate_limited',
      detail: `Over quota. Retry after ${verdict.retryAfterSeconds}s.`,
    });
    return;
  }
  res.setHeader('X-RateLimit-Remaining', String(verdict.remaining));

  // Express speaks Node's req/res; the SDK transport speaks web Fetch types.
  const webRequest = await toWebRequest(req);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = buildMcpServer();
  const dispose = async (): Promise<void> => {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  };
  await server.connect(transport);

  const webResponse = await transport.handleRequest(webRequest);
  if (webResponse.body === null) {
    await dispose();
    sendWebResponse(res, webResponse, dispose);
    return;
  }
  sendWebResponse(res, webResponse, dispose);
});

mcpRouter.get('/mcp', (_req, res) => {
  for (const [k, v] of Object.entries(MCP_HEADERS)) res.setHeader(k, v);
  res.status(405).json({
    error: 'method_not_allowed',
    detail: 'This MCP server is stateless: use POST for JSON-RPC. There is no server-initiated stream to open.',
  });
});

mcpRouter.options('/mcp', (_req, res) => {
  for (const [k, v] of Object.entries(MCP_HEADERS)) res.setHeader(k, v);
  res.status(204).end();
});

async function toWebRequest(req: ExpressRequest): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  const url = `${req.protocol}://${req.get('host') ?? 'localhost'}${req.originalUrl}`;
  return new Request(url, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: body.byteLength > 0 ? body : undefined,
    duplex: 'half',
  } as RequestInit);
}

/**
 * Stream the web Response into the Express response, disposing the server and
 * transport once the client has actually drained the body.
 */
function sendWebResponse(
  res: ExpressResponse,
  webResponse: Response,
  dispose: () => Promise<void>,
): void {
  webResponse.headers.forEach((value, key) => {
    if (!res.getHeader(key)) res.setHeader(key, value);
  });
  res.status(webResponse.status);

  if (webResponse.body === null) {
    void dispose();
    res.end();
    return;
  }

  const reader = webResponse.body.getReader();
  const finish = (): void => {
    void dispose().catch(() => undefined);
  };
  res.on('close', finish);

  void (async () => {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        res.write(Buffer.from(next.value));
      }
      res.end();
      finish();
    } catch (err) {
      log.warn('mcp response stream failed', { message: err instanceof Error ? err.message : String(err) });
      res.end();
      finish();
    }
  })();
}

export { advertisedTools, getMcpTool };
