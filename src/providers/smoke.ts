/**
 * Manual smoke check: proves each configured provider answers a plain prompt
 * and returns a normalized tool call, behind the single abstraction.
 *
 *   pnpm providers:smoke            # every provider that has an API key
 *   pnpm providers:smoke openai     # just one
 *
 * Requires real API keys in .env; providers without a key are skipped.
 */
import { z } from 'zod';
import type { GenerateRequest, ProviderName } from '../llm/types.js';
import { ALL_PROVIDERS, createProvider, hasApiKey } from './registry.js';

const weatherTool = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: z.object({ city: z.string().describe('City name') }),
};

async function checkProvider(name: ProviderName): Promise<void> {
  const provider = createProvider(name);
  console.log(`\n=== ${name} (${provider.model}) ===`);

  const plain: GenerateRequest = {
    system: 'You are terse.',
    messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
  };
  let t0 = Date.now();
  const a = await provider.generate(plain);
  console.log(
    `  plain   → text=${JSON.stringify(a.text)} tokens=${a.usage.inputTokens}/${a.usage.outputTokens} ${Date.now() - t0}ms`,
  );

  const withTool: GenerateRequest = {
    messages: [{ role: 'user', content: "What's the weather in Paris? Use the tool." }],
    tools: [weatherTool],
    toolChoice: 'auto',
  };
  t0 = Date.now();
  const b = await provider.generate(withTool);
  console.log(
    `  tool    → calls=${JSON.stringify(b.toolCalls)} finish=${b.finishReason} ${Date.now() - t0}ms`,
  );
}

async function main(): Promise<void> {
  const arg = process.argv[2] as ProviderName | undefined;
  const targets = (arg ? [arg] : ALL_PROVIDERS).filter((p) => {
    if (hasApiKey(p)) return true;
    console.log(`(skipping ${p}: no API key)`);
    return false;
  });

  if (targets.length === 0) {
    console.log('No providers with API keys configured. Set keys in .env.');
    return;
  }

  for (const name of targets) {
    try {
      await checkProvider(name);
    } catch (err) {
      console.error(`  ERROR (${name}):`, err instanceof Error ? err.message : err);
    }
  }
}

void main();
