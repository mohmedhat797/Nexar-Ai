import { describe, expect, it, vi } from 'vitest';
import type { ChildTaskInput } from '@nexar/engine-gateway';
import type { EngineHost } from './engine-host.js';
const executed = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ text: 'synthetic', resourceId: 'pi', usage: {} }),
);
vi.mock('@nexar/host', () => ({ createEngineExecutor: () => executed }));
import { boundedCoworkExecutor } from './cowork-executor.js';

describe('Cowork delegation retains isolation', () => {
  it('hard-excludes native agents and mislabelled adapter bindings while preserving existing exclusions', async () => {
    const descriptors = [
      { id: 'pi', kind: { type: 'model' }, runtime: { adapter: 'pi' } },
      { id: 'echo', kind: { type: 'model' }, runtime: { adapter: 'echo' } },
      { id: 'native', kind: { type: 'agent' }, runtime: { adapter: 'codex' } },
      { id: 'mislabelled', kind: { type: 'model' }, runtime: { adapter: 'claude-code' } },
    ];
    const engine = {
      composition: () => ({ runtime: { registry: { list: () => descriptors } } }),
    } as unknown as EngineHost;
    const input = {
      requirements: { excludedResourceIds: ['owner-exclusion'] },
    } as unknown as ChildTaskInput;
    const signal = new AbortController().signal;
    await boundedCoworkExecutor(engine)(input, signal);
    expect(executed).toHaveBeenLastCalledWith(
      expect.objectContaining({
        requirements: { excludedResourceIds: ['owner-exclusion', 'native', 'mislabelled'] },
      }),
      signal,
    );
  });
});
