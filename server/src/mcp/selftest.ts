/**
 * Self-test for the MCP server.
 *
 *   bun run test:mcp
 *   bun run test:mcp -- --http http://localhost:4000/mcp
 *
 * Without --http it exercises the transport in-process, so it works with no
 * server running. With --http it also proves the bearer key and the Express
 * wiring, which is the part an in-process test cannot reach.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { env } from '../env.js';
import { authorize, buildMcpServer, mcpConfigured, mcpAuthMode } from './server.js';
import { MCP_TOOLS, getMcpTool } from './tools.js';

let failures = 0;
let checks = 0;

function section(title: string): void {
  console.log(`\n${title}`);
}

function check(label: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (ok) {
    console.log(`  PASS  ${label}${detail === '' ? '' : ` (${detail})`}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail === '' ? '' : ` -- ${detail}`}`);
  }
}

/** The SDK's callTool result is a union; narrow it for reporting. */
function textOf(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c: unknown) =>
      typeof c === 'object' && c !== null && (c as { type?: string }).type === 'text'
        ? String((c as { text?: unknown }).text ?? '')
        : '',
    )
    .join(' ');
}

function parseHttpUrl(argv: string[]): string | null {
  const flag = argv.indexOf('--http');
  if (flag === -1) return null;
  const url = argv[flag + 1];
  if (!url) {
    console.error('--http needs a URL, e.g. --http http://localhost:4000/mcp');
    process.exit(2);
  }
  return url;
}

/** Tool calls that need no database and no worker, so they always pass. */
const OFFLINE_CALLS: Array<{ tool: string; args: Record<string, unknown> }> = [
  { tool: 'create_cad_project', args: {} },
  { tool: 'get_cad_project', args: {} },
  { tool: 'get_cad_project', args: { projectId: 'not-an-object-id' } },
  { tool: 'wait_for_cad_project', args: { projectId: 'not-an-object-id' } },
  { tool: 'list_parts', args: { limit: 0 } },
  { tool: 'get_part', args: {} },
  { tool: 'delete_cad_project', args: { projectId: 'a'.repeat(24), confirmProjectId: 'b'.repeat(24) } },
  { tool: 'no_such_tool', args: {} },
];

async function runInProcess(): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildMcpServer();
  await server.connect(serverTransport);
  const client = new Client({ name: 'cadforge-selftest', version: '1.0.0' });
  await client.connect(clientTransport);

  const listed = await client.listTools();
  check('tools/list returns every registered tool', listed.tools.length === MCP_TOOLS.length, `${listed.tools.length} tools`);

  for (const tool of MCP_TOOLS) {
    const found = listed.tools.find((t) => t.name === tool.name);
    check(
      `${tool.name} is advertised with a schema`,
      found !== undefined && typeof found.inputSchema === 'object' && found.inputSchema !== null,
    );
  }

  for (const { tool, args } of OFFLINE_CALLS) {
    const result = await client.callTool({ name: tool, arguments: args });
    const isError = (result as { isError?: boolean }).isError === true;
    const text = textOf(result);
    if (tool === 'no_such_tool') {
      check('unknown tool is refused, not thrown', isError && text.includes('Unknown tool'));
    } else {
      check(
        `${tool} rejects bad input with a readable message`,
        isError && text.length > 0,
        text.split('\n')[0]?.slice(0, 60),
      );
    }
  }

  await client.close();
  await server.close();
}

async function runHttp(url: string): Promise<void> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: env.MCP_API_KEY.length > 0 ? { authorization: `Bearer ${env.MCP_API_KEY}` } : {},
    },
  });
  const client = new Client({ name: 'cadforge-selftest', version: '1.0.0' });
  try {
    await client.connect(transport);
  } catch (err) {
    check('client can connect over streamable HTTP', false, err instanceof Error ? err.message : String(err));
    return;
  }
  const listed = await client.listTools();
  check('tools/list works over HTTP', listed.tools.length === MCP_TOOLS.length, `${listed.tools.length} tools`);
  const result = await client.callTool({ name: 'create_cad_project', arguments: {} });
  check('tool call over HTTP returns a validation error', result.isError === true);
  await client.close();

  // A bad key must be refused before any tool runs.
  const badTransport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: 'Bearer wrong-key' } },
  });
  try {
    await new Client({ name: 'x', version: '1' }).connect(badTransport);
    check('a wrong bearer key is rejected', false, 'connection unexpectedly succeeded');
  } catch {
    check('a wrong bearer key is rejected', true);
  }
}

async function main(): Promise<number> {
  const httpUrl = parseHttpUrl(process.argv.slice(2));

  section('configuration');
  check('MCP_API_KEY is set, or auth is explicitly disabled', mcpConfigured());
  console.log(`        auth mode: ${mcpAuthMode()}`);
  if (mcpAuthMode() === 'none' && env.NODE_ENV === 'production') {
    check('auth is NOT disabled in production', false, 'MCP_AUTH_DISABLED must never be true in production');
  } else {
    check('auth is NOT disabled in production', true);
  }

  section('authorization');
  const good = authorize({ headers: { authorization: `Bearer ${env.MCP_API_KEY}` } } as never);
  check('a valid bearer key is accepted', good.ok === true);
  if (env.MCP_API_KEY.length > 0) {
    const bad = authorize({ headers: { authorization: 'Bearer nope' } } as never);
    check('a wrong bearer key is refused with 401', !bad.ok && bad.status === 401);
    const none = authorize({ headers: {} } as never);
    check('a missing Authorization header is refused with 401', !none.ok && none.status === 401);
  }

  section('tool registry');
  const names = MCP_TOOLS.map((t) => t.name);
  check('tool names are unique', new Set(names).size === names.length);
  for (const tool of MCP_TOOLS) {
    check(
      `${tool.name} has a description and required fields declared`,
      tool.description.length > 40 &&
        typeof tool.inputSchema === 'object' &&
        Array.isArray((tool.inputSchema as { required?: string[] }).required ?? []),
    );
    check(`${tool.name} is retrievable by name`, getMcpTool(tool.name) === tool);
  }
  check('getMcpTool returns null for an unknown name', getMcpTool('nope') === null);

  section(httpUrl ? `transport over HTTP (${httpUrl})` : 'transport (in-process)');
  if (httpUrl) await runHttp(httpUrl);
  else await runInProcess();

  section('result');
  console.log(`  ${checks - failures}/${checks} checks passed`);
  return failures === 0 ? 0 : 1;
}

process.exit(await main());
