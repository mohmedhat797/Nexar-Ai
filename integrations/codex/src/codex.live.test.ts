import { describe, expect, it } from 'vitest';
import { CodexExecutionAdapter, codexResource } from './index.js';
import { silentLogger, task } from './test/harness.js';

// Opt-in: talks to the real, logged-in `codex` CLI and may consume subscription quota.
// Needs NEXAR_LIVE_TESTS=1 and NEXAR_CODEX_BIN pointing at the binary. Never runs in CI.
describe.skipIf(!process.env['NEXAR_LIVE_TESTS'] || !process.env['NEXAR_CODEX_BIN'])(
  'codex (live)',
  () => {
    it('answers a tiny read-only prompt', async () => {
      const adapter = new CodexExecutionAdapter({ binary: process.env['NEXAR_CODEX_BIN'] ?? '' });
      const result = await adapter.execute(
        { task: task({ prompt: 'Reply with exactly: NEXAR_OK' }), resource: codexResource() },
        { signal: AbortSignal.timeout(180_000), logger: silentLogger },
      );

      expect(result.text).toContain('NEXAR_OK');
      expect(result.usage.costUsd.status).toBe('unavailable');
      expect(result.resolved.provider).toBe('openai');
    }, 190_000);
  },
);
