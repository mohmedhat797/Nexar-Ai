import { describe, expect, it } from 'vitest';
import { ClaudeCodeExecutionAdapter, claudeCodeResource } from './index.js';
import { silentLogger, task } from './test/harness.js';

// Opt-in: talks to the real, logged-in `claude` CLI and may consume subscription quota.
describe.skipIf(!process.env['NEXAR_LIVE_TESTS'])('claude-code (live)', () => {
  it('answers a one-turn prompt', async () => {
    const adapter = new ClaudeCodeExecutionAdapter();
    const base = claudeCodeResource();
    const resource = {
      ...base,
      runtime: { ...base.runtime, options: { permissionMode: 'plan', maxTurns: 1 } },
    };

    const result = await adapter.execute(
      { task: task({ prompt: 'Reply with exactly: NEXAR_OK' }), resource },
      { signal: AbortSignal.timeout(120_000), logger: silentLogger },
    );

    expect(result.text).toContain('NEXAR_OK');
    expect(result.usage.inputTokens.status).toBe('measured');
    expect(result.usage.outputTokens.status).toBe('measured');
    expect(result.usage.costUsd.status).toBe('estimated');
    expect(result.resolved.provider).toBe('anthropic');
  }, 130_000);
});
