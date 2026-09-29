import { describe, expect, test } from 'bun:test';
import { MCP_TOOLS, advertisedTools, getMcpTool } from '../mcp/tools.js';
import { authorize, buildMcpServer, mcpAuthMode, mcpConfigured, takeQuota } from '../mcp/server.js';
import { env } from '../env.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

/**
 * The SDK's callTool result is a union (a tool result or a task result), so
 * assertions narrow it through this rather than assuming a shape.
 */
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

function isToolError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

const REQUIRED_TOOLS = [
  'create_cad_project',
  'get_cad_project',
  'wait_for_cad_project',
  'list_cad_projects',
  'get_cad_artifacts',
  'list_parts',
  'get_part',
  'verify_part',
  'delete_part',
  'delete_cad_project',
  'cadforge_health',
];

describe('tool registry', () => {
  test('every required tool exists', () => {
    for (const name of REQUIRED_TOOLS) {
      expect(getMcpTool(name)).not.toBeNull();
    }
  });

  test('tool names are unique', () => {
    const names = MCP_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('unknown tool returns null', () => {
    expect(getMcpTool('does_not_exist')).toBeNull();
  });

  test('every tool has a substantial description and a valid JSON schema', () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.inputSchema['type']).toBe('object');
      const props = tool.inputSchema['properties'];
      expect(typeof props).toBe('object');
      expect(props).not.toBeNull();
      expect(Array.isArray(props)).toBe(false);
      expect(tool.inputSchema['additionalProperties']).toBe(false);
    }
  });

  test('tools with required inputs declare them', () => {
    const needsInput = MCP_TOOLS.filter((t) => t.name !== 'cadforge_health' && t.name !== 'list_cad_projects' && t.name !== 'list_parts');
    for (const tool of needsInput) {
      expect(Array.isArray(tool.inputSchema['required'])).toBe(true);
      expect((tool.inputSchema['required'] as string[]).length).toBeGreaterThan(0);
    }
  });

  test('destructive tools require a confirmation argument', () => {
    const del = getMcpTool('delete_cad_project');
    expect(del?.inputSchema['required']).toEqual(['projectId', 'confirmProjectId']);
  });

  test('the core tools survive with no LLM pipeline configured', () => {
    // The whole point of the agent-driven path: an agent can build models
    // without this server holding an Anthropic or Tavily key.
    const core = advertisedTools(false).map((t) => t.name);
    expect(core).toContain('build_cad_model');
    expect(core).toContain('list_parts');
    expect(core).toContain('get_part');
    expect(core).toContain('cadforge_health');
    // The self-contained pipeline is hidden, not advertised and then refused.
    expect(core).not.toContain('create_cad_project');
  });

  test('every tool is advertised when the pipeline is configured', () => {
    expect(advertisedTools(true).map((t) => t.name).sort()).toEqual(
      MCP_TOOLS.map((t) => t.name).sort(),
    );
  });

  test('build_cad_model is the primary tool and takes explicit millimetres', () => {
    const build = getMcpTool('build_cad_model');
    expect(build).not.toBeNull();
    // The agent must be told it owns the research, or it will assume we guess.
    expect(build!.description).toContain('YOU do the research');
    expect(build!.description).toContain('millimetre');
    const props = build!.inputSchema['properties'] as Record<string, unknown>;
    expect(Object.keys(props)).toContain('parts');
    expect(props['parts']).toBeDefined();
  });
});

describe('authorization', () => {
  test('MCP is configured when a key is present', () => {
    expect(mcpConfigured()).toBe(true);
    expect(env.MCP_API_KEY.length).toBeGreaterThan(0);
  });

  test('the correct bearer key is accepted', () => {
    const result = authorize({ headers: { authorization: `Bearer ${env.MCP_API_KEY}` } } as never);
    expect(result.ok).toBe(true);
  });

  test('a wrong bearer key is refused with 401', () => {
    const result = authorize({ headers: { authorization: 'Bearer wrong-key' } } as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.code).toBe('unauthorized');
    }
  });

  test('a missing header is refused with 401', () => {
    const result = authorize({ headers: {} } as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  test('a non-bearer scheme is refused', () => {
    const result = authorize({ headers: { authorization: `Basic ${env.MCP_API_KEY}` } } as never);
    expect(result.ok).toBe(false);
  });

  test('auth mode is bearer by default in tests', () => {
    expect(mcpAuthMode()).toBe('bearer');
  });
});

describe('rate quota', () => {
  test('allows reads up to the limit then refuses', () => {
    let allowed = 0;
    for (let i = 0; i < 130; i += 1) {
      if (takeQuota('quota-read-test', false).allowed) allowed += 1;
    }
    expect(allowed).toBe(120);
  });

  test('writes have a tighter limit than reads', () => {
    let allowed = 0;
    for (let i = 0; i < 40; i += 1) {
      if (takeQuota('quota-write-test', true).allowed) allowed += 1;
    }
    expect(allowed).toBe(30);
  });

  test('a refusal carries a retry-after', () => {
    const key = 'quota-retry-test';
    for (let i = 0; i < 121; i += 1) takeQuota(key, false);
    const verdict = takeQuota(key, false);
    expect(verdict.allowed).toBe(false);
    expect(verdict.retryAfterSeconds).toBeGreaterThan(0);
    expect(verdict.retryAfterSeconds).toBeLessThanOrEqual(60);
  });
});

describe('MCP protocol behaviour (in-process)', () => {
  async function connect(): Promise<{ client: Client; server: Server }> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientTransport);
    return { client, server };
  }

  test('initialize succeeds and advertises the tools capability', async () => {
    const { client, server } = await connect();
    const caps = client.getServerCapabilities();
    expect(caps?.tools).toBeDefined();
    await client.close();
    await server.close();
  });

  test('tools/list returns every registered tool', async () => {
    const { client, server } = await connect();
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(MCP_TOOLS.length);
    await client.close();
    await server.close();
  });

  test('tools/list exposes a usable inputSchema per tool', async () => {
    const { client, server } = await connect();
    const listed = await client.listTools();
    for (const tool of listed.tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.description?.length ?? 0).toBeGreaterThan(40);
    }
    await client.close();
    await server.close();
  });

  test('an unknown tool name is refused, not thrown', async () => {
    const { client, server } = await connect();
    const result = await client.callTool({ name: 'no_such_tool', arguments: {} });
    expect(isToolError(result)).toBe(true);
    const text = textOf(result);
    expect(text).toContain('Unknown tool');
    await client.close();
    await server.close();
  });

  test('missing required arguments produce a validation error, not a crash', async () => {
    const { client, server } = await connect();
    const result = await client.callTool({ name: 'create_cad_project', arguments: {} });
    expect(isToolError(result)).toBe(true);
    const text = textOf(result);
    expect(text).toContain('prompt');
    await client.close();
    await server.close();
  });

  test('a malformed project id is rejected before any database call', async () => {
    const { client, server } = await connect();
    const result = await client.callTool({ name: 'get_cad_project', arguments: { projectId: 'nope' } });
    expect(isToolError(result)).toBe(true);
    await client.close();
    await server.close();
  });

  test('mismatched delete confirmation is refused', async () => {
    const { client, server } = await connect();
    const result = await client.callTool({
      name: 'delete_cad_project',
      arguments: { projectId: 'a'.repeat(24), confirmProjectId: 'b'.repeat(24) },
    });
    expect(isToolError(result)).toBe(true);
    const text = textOf(result);
    expect(text).toContain('does not match');
    await client.close();
    await server.close();
  });

  test('out-of-range numbers are rejected', async () => {
    const { client, server } = await connect();
    const result = await client.callTool({ name: 'list_parts', arguments: { limit: 0 } });
    expect(isToolError(result)).toBe(true);
    await client.close();
    await server.close();
  });
});
