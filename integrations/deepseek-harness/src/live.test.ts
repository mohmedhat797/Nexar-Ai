import { describe, expect, it } from 'vitest';
import { DeepSeekHarnessExecutionAdapter } from './adapter.js';
import { deepseekHarnessResource } from './resource.js';
import { makeContext, makeTask, makeTempDir } from './test/support.js';

// Opt-in: makes one real (paid) model call through an installed `dsh`.
describe.skipIf(!process.env.NEXAR_LIVE_TESTS || !process.env.DEEPSEEK_API_KEY)(
  'DeepSeek Harness live run',
  () => {
    it('answers one tiny prompt', async () => {
      const adapter = new DeepSeekHarnessExecutionAdapter({
        ...(process.env.NEXAR_DSH_BIN === undefined ? {} : { binary: process.env.NEXAR_DSH_BIN }),
      });
      const task = makeTask({ workingDirectory: makeTempDir() });
      const result = await adapter.execute(
        {
          task: { ...task, input: { ...task.input, prompt: 'Reply with the single word: pong' } },
          resource: deepseekHarnessResource(),
        },
        makeContext(),
      );
      expect(result.text.length).toBeGreaterThan(0);
      expect(result.resolved.runtimeVersion).toBeDefined();
    }, 180_000);
  },
);
