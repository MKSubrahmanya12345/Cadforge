import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

/** Repo root = one level above /server. */
export const REPO_ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/**
 * `override: false` is the safe default here: a value already in the process
 * environment wins. That is what lets the test preload pin a hermetic
 * environment even though a developer's real .env is sitting on disk.
 */
loadEnv({ path: `${REPO_ROOT}/.env`, override: false });

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),

  // Optional. The MCP surface is a pure CAD service: the calling agent (ChatGPT,
  // Claude, anything) does the research and the planning, then hands us explicit
  // dimensions. A key is only needed for the optional web-UI pipeline, which
  // runs its own LLM stages. Leaving these empty disables that path and nothing
  // else — /mcp works with no keys at all.
  ANTHROPIC_API_KEY: z.string().default(''),
  ANTHROPIC_MODEL: z.string().min(1).default('claude-sonnet-4-5'),
  TAVILY_API_KEY: z.string().default(''),

  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required — Atlas URI or mongodb://127.0.0.1:27017/cadforge'),

  STORAGE_DIR: z.string().min(1).default('./storage'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(120),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),

  MAX_FETCH_BYTES: z.coerce.number().int().min(1024).default(8 * 1024 * 1024),
  LLM_MAX_RETRIES: z.coerce.number().int().min(1).max(10).default(3),
  CODE_TIMEOUT_S: z.coerce.number().int().min(1).max(600).default(30),
  VALIDATE_MAX_RETRIES: z.coerce.number().int().min(0).max(20).default(4),
  CAD_WORKER_URL: z.string().url().default('http://127.0.0.1:8000'),
  MAX_PARTS_PER_PROJECT: z.coerce.number().int().min(1).max(50).default(12),

});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Parse and validate the environment, failing fast with every missing key at
 * once so a misconfigured install is fixed in one pass.
 */
export function loadEnvStrict(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (result.success) return result.data;

  const issues = result.error.issues.map((i) => {
    const key = i.path.join('.') || '(root)';
    return `  - ${key}: ${i.message}`;
  });
  const error = new Error(
    `Invalid environment configuration:\n${issues.join('\n')}\n\n` +
      `Copy ${REPO_ROOT}/.env.example to ${REPO_ROOT}/.env and fill in the values.`,
  );
  error.name = 'EnvValidationError';
  throw error;
}

export const env: Env = loadEnvStrict();
