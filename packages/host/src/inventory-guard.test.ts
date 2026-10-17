import { describe, expect, it, vi } from 'vitest';
import {
  adapterId,
  resourceId,
  NexarError,
  emptyUsage,
  type ExecutionAdapter,
  type ResourceDescriptor,
} from '@nexar/contracts';
import { guardInventoryAdapter } from './inventory-guard.js';

const resource: ResourceDescriptor = {
  id: resourceId('inventory:example'),
  displayName: 'Native model',
  kind: { type: 'agent', agent: 'fake', interface: 'cli' },
  capabilities: ['coding'],
  runtime: { adapter: adapterId('fake'), locality: 'local' },
  auth: {
    mode: 'subscription',
    credential: { source: 'runtime-managed', description: 'Fake native profile' },
  },
  cost: { model: 'subscription' },
  dataLocality: 'third-party',
  metadata: { inventory: {} },
};
function fixture() {
  const execute = vi.fn<ExecutionAdapter['execute']>().mockResolvedValue({
    text: 'ok',
    artifacts: [],
    usage: emptyUsage(),
    resolved: {},
    retries: 0,
  });
  const probe = vi.fn<ExecutionAdapter['probe']>().mockResolvedValue({
    availability: 'available',
    auth: 'unknown',
    observedAt: new Date().toISOString(),
  });
  const isAvailable = vi.fn().mockReturnValue(true);
  const onModelRejected = vi.fn();
  const adapter = guardInventoryAdapter(
    { id: adapterId('fake'), displayName: 'Fake', supports: () => true, execute, probe },
    { isAvailable, onModelRejected },
  );
  const context = {
    signal: new AbortController().signal,
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: () => context.logger,
    },
  };
  const request = { resource, task: {} as never };
  return { execute, probe, isAvailable, onModelRejected, adapter, context, request };
}
describe('inventory execution guard', () => {
  it('retains admission through actual native probe settlement and failure cleanup', async () => {
    let finish!: (value: Awaited<ReturnType<ExecutionAdapter['probe']>>) => void;
    const release = vi.fn(),
      validate = vi.fn();
    const probe = vi.fn<ExecutionAdapter['probe']>().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const adapter = guardInventoryAdapter(
      { id: adapterId('fake'), displayName: 'Fake', supports: () => true, probe, execute: vi.fn() },
      {
        isAvailable: () => true,
        onModelRejected: () => undefined,
        acquire: () => Promise.resolve({ release }),
        validate,
      },
    );
    const pending = adapter.probe(resource, new AbortController().signal);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
    expect(release).not.toHaveBeenCalled();
    expect(validate).toHaveBeenCalledWith(resource);
    finish({ availability: 'available', auth: 'unknown', observedAt: new Date().toISOString() });
    await pending;
    expect(release).toHaveBeenCalledOnce();
    probe.mockRejectedValueOnce(Error('synthetic native failure'));
    await expect(adapter.probe(resource, new AbortController().signal)).rejects.toThrow(
      'synthetic native failure',
    );
    expect(release).toHaveBeenCalledTimes(2);
  });
  it('blocks a stale previously probed resource without invoking its runtime and preserves ordinary native resources', async () => {
    const f = fixture();
    expect((await f.adapter.probe(resource, f.context.signal)).availability).toBe('available');
    f.isAvailable.mockReturnValue(false);
    await expect(f.adapter.execute(f.request, f.context)).rejects.toMatchObject({
      code: 'RESOURCE_UNAVAILABLE',
      retryable: false,
    });
    expect(f.execute).not.toHaveBeenCalled();
    const ordinary = { ...resource };
    delete ordinary.metadata;
    await f.adapter.execute({ ...f.request, resource: ordinary }, f.context);
    expect(f.execute).toHaveBeenCalledOnce();
  });
  it('rechecks freshness after an asynchronous native probe and invalidates only structured model rejection', async () => {
    const f = fixture();
    f.probe.mockImplementation(() => {
      f.isAvailable.mockReturnValue(false);
      return Promise.resolve({
        availability: 'available',
        auth: 'unknown',
        observedAt: new Date().toISOString(),
      });
    });
    expect((await f.adapter.probe(resource, f.context.signal)).availability).toBe('unavailable');
    f.isAvailable.mockReturnValue(true);
    f.execute.mockRejectedValueOnce(
      new NexarError('PROVIDER_ERROR', 'Fixed failure', {
        retryable: false,
        details: { reason: 'model-rejected' },
      }),
    );
    await expect(f.adapter.execute(f.request, f.context)).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
    expect(f.onModelRejected).toHaveBeenCalledOnce();
    f.execute.mockRejectedValueOnce(new NexarError('PROVIDER_ERROR', 'Unrelated failure'));
    await expect(f.adapter.execute(f.request, f.context)).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
    expect(f.onModelRejected).toHaveBeenCalledOnce();
  });
});
