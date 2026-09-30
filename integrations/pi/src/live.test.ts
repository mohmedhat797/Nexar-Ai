import { taskId } from '@nexar/contracts';
import type { Logger } from '@nexar/contracts';
import { describe, expect, it } from 'vitest';
import { PiExecutionAdapter, piModelResource } from './index.js';

// Opt-in live test: costs a few tokens on the real Anthropic API. Run with
//   NEXAR_LIVE_TESTS=1 ANTHROPIC_API_KEY=... pnpm test
// Override the model with NEXAR_LIVE_PI_MODEL (default claude-haiku-4-5). Never runs in CI.
const enabled = Boolean(process.env.NEXAR_LIVE_TESTS) && Boolean(process.env.ANTHROPIC_API_KEY);

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

describe.skipIf(!enabled)('pi-ai live (anthropic)', () => {
  it('completes a tiny prompt and reports usage', async () => {
    const adapter = new PiExecutionAdapter();
    const resource = piModelResource({
      id: 'live-anthropic',
      provider: 'anthropic',
      model: process.env.NEXAR_LIVE_PI_MODEL ?? 'claude-haiku-4-5',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
    });
    const result = await adapter.execute(
      {
        resource,
        task: {
          id: taskId('live-1'),
          kind: 'general',
          input: { prompt: 'Reply with the single word: pong' },
          requirements: { capabilities: ['text-generation'] },
          origin: { source: 'test' },
          createdAt: new Date().toISOString(),
        },
      },
      { signal: AbortSignal.timeout(60_000), logger },
    );
    expect(result.text.toLowerCase()).toContain('pong');
    expect(result.usage.inputTokens.status).toBe('measured');
  }, 70_000);
});
