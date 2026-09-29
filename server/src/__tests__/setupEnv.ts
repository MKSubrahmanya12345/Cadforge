/**
 * Preloaded by bunfig.toml before any test file is imported.
 *
 * src/env.ts validates the environment at import time and fails fast, which is
 * the right behaviour for `bun run dev` but would make unit tests impossible to
 * run without real credentials. It also calls dotenv, which loads the repo's
 * real .env — including a real MCP_API_KEY and whatever MCP_AUTH_DISABLED is set
 * to.
 *
 * These assignments are deliberately unconditional, not `??=`: a test must be
 * hermetic. A developer's real .env must not be able to change what the test
 * suite asserts, and a test must never send a real API key anywhere.
 */
const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  ANTHROPIC_API_KEY: 'test-anthropic-key-not-real',
  ANTHROPIC_MODEL: 'claude-sonnet-4-5',
  TAVILY_API_KEY: 'test-tavily-key-not-real',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/cadforge-test',
  LOG_LEVEL: 'error',
  STORAGE_DIR: './storage',
  CAD_WORKER_URL: 'http://127.0.0.1:8000',
  MCP_API_KEY: 'test-mcp-key-not-real',
  MCP_AUTH_DISABLED: 'false',
};

for (const [key, value] of Object.entries(TEST_ENV)) {
  process.env[key] = value;
}
