import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

/**
 * Central, validated configuration. Everything the harness reads from the
 * environment funnels through this schema so a missing/invalid value fails
 * loudly at boot rather than deep in a request.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // --- LLM providers (Phase 1) ---
  LLM_PROVIDER: z.enum(['claude', 'openai', 'gemini']).default('claude'),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
  // Optional OpenAI-compatible base URL (e.g. OpenRouter: https://openrouter.ai/api/v1).
  // When set, the openai provider routes through it via the chat-completions API.
  OPENAI_BASE_URL: z.string().optional(),
  CLAUDE_MODEL: z.string().default('claude-sonnet-5'),
  OPENAI_MODEL: z.string().default('gpt-4.1'),
  GEMINI_MODEL: z.string().default('gemini-2.0-flash'),

  // --- Embeddings ---
  // Local mode runs a Transformers.js model on-device (no API key). When false,
  // embeddings use the cloud EMBED_PROVIDER + EMBED_MODEL below.
  EMBED_LOCAL: z
    .preprocess(
      (v) => (typeof v === 'string' ? ['1', 'true', 'yes'].includes(v.toLowerCase()) : v),
      z.boolean(),
    )
    .default(false),
  EMBED_LOCAL_MODEL: z.string().default('Xenova/bge-small-en-v1.5'),
  EMBED_PROVIDER: z.enum(['openai', 'gemini']).default('openai'),
  EMBED_MODEL: z.string().default('text-embedding-3-small'),

  // --- CRM (mock until sandbox wired in Phase 7) ---
  CRM_MODE: z.enum(['mock', 'highlevel']).default('mock'),
  // Simplest auth: a Private Integration Token (static bearer). When set, the
  // client uses it directly and skips OAuth entirely. Otherwise OAuth is used.
  HL_PRIVATE_TOKEN: z.string().optional(),
  HL_CLIENT_ID: z.string().optional(),
  HL_CLIENT_SECRET: z.string().optional(),
  HL_REDIRECT_URI: z.string().optional(),
  HL_LOCATION_ID: z.string().optional(),
  HL_WEBHOOK_SECRET: z.string().optional(),
  HL_CALENDAR_ID: z.string().optional(),
  /** User the booked appointment is assigned to (HighLevel requires this). */
  HL_CALENDAR_USER_ID: z.string().optional(),
  HL_FIELD_BUDGET_ID: z.string().optional(),
  HL_FIELD_PREFERRED_TIME_ID: z.string().optional(),
  HL_HANDOVER_TAG: z.string().default('bot-handover'),
  HL_HANDOVER_USER_ID: z.string().optional(),

  // --- RAG ---
  RAG_SCORE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.35),

  // Minutes of inactivity after which a conversation's in-memory context is
  // reset (a returning visitor's "new chat" starts fresh; a refresh keeps it).
  HISTORY_IDLE_RESET_MIN: z.coerce.number().positive().default(30),

  // --- Persistence (optional) ---
  // When set, the webhook idempotency store is backed by Postgres instead of an
  // in-memory map. Absent = the zero-infra defaults (file KB, in-memory dedup).
  DATABASE_URL: z.string().optional(),
  // The pgvector KB is opt-in ON TOP of DATABASE_URL, because it needs the
  // `vector` extension (Fly's unmanaged Postgres image lacks it). When false,
  // the KB uses the baked on-disk index even if DATABASE_URL is set.
  PGVECTOR: z
    .preprocess(
      (v) => (typeof v === 'string' ? ['1', 'true', 'yes'].includes(v.toLowerCase()) : v),
      z.boolean(),
    )
    .default(false),

  // --- Tracing (optional; absent = Langfuse disabled, JSON/CLI stays on) ---
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_BASEURL: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

function parseEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env = parseEnv();

/** True when the real HighLevel client should be used instead of the mock. */
export const isLiveCrm = env.CRM_MODE === 'highlevel';

/** True when a Postgres-backed idempotency store should be used. */
export const isDbEnabled = Boolean(env.DATABASE_URL);

/** True when the KB should use pgvector (requires DATABASE_URL + the extension). */
export const isPgVectorEnabled = isDbEnabled && env.PGVECTOR;
