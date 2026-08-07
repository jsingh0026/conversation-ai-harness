import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';
import { openai } from '@ai-sdk/openai';
import { env } from '../config/env.js';
import type { LLMProvider, ProviderName } from '../llm/types.js';
import { AiSdkProvider } from './ai-sdk-provider.js';

/**
 * Which env var each provider reads for its API key. Used only to give a clear
 * error before a call fails deep in the SDK.
 */
const KEY_ENV: Record<ProviderName, keyof typeof env> = {
  claude: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GOOGLE_GENERATIVE_AI_API_KEY',
};

/**
 * Build a provider by name. A fourth provider is a new case here + a model
 * handle — no other file changes. Defaults to the configured `LLM_PROVIDER`.
 */
export function createProvider(name: ProviderName = env.LLM_PROVIDER): LLMProvider {
  switch (name) {
    case 'claude':
      return new AiSdkProvider('claude', env.CLAUDE_MODEL, anthropic(env.CLAUDE_MODEL));
    case 'openai':
      return new AiSdkProvider('openai', env.OPENAI_MODEL, openai(env.OPENAI_MODEL));
    case 'gemini':
      return new AiSdkProvider('gemini', env.GEMINI_MODEL, google(env.GEMINI_MODEL));
    default:
      throw new Error(`Unknown provider: ${String(name)}`);
  }
}

/** True if the provider's API key is present in the environment. */
export function hasApiKey(name: ProviderName): boolean {
  return Boolean(env[KEY_ENV[name]]);
}

export const ALL_PROVIDERS: readonly ProviderName[] = ['claude', 'openai', 'gemini'];
