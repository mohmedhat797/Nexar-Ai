import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InventorySourceResult } from '@nexar/contracts';
import { chatGptPlanModelResource } from '@nexar/host';
import { InventoryArgsSchema, InventoryCacheSchema } from '../shared/provider-inventory.js';
import { ProviderInventoryService, type InventoryDefinition } from './provider-inventory.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nx-inventory-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const identity = {
  provider: 'openai',
  connectionId: 'openai.chatgpt-plan',
  runtimeId: 'pi',
  routeId: 'openai.responses.account',
  machine: 'desktop',
} as const;
const success = (id: string): Extract<InventorySourceResult, { status: 'success' }> => ({
  status: 'success',
  source: 'official-api',
  auth: 'authenticated',
  entries: [
    {
      selection: { kind: 'model', id },
      displayName: id,
      availability: 'available',
      compatibility: 'model-turn',
    },
  ],
});
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
};
const definition = (fetch: InventoryDefinition['source']['fetch']): InventoryDefinition => ({
  sourceId: 'chatgpt-plan',
  identity,
  source: { fetch },
  template: (entry) =>
    chatGptPlanModelResource(entry.selection.kind === 'model' ? entry.selection.id : 'unused'),
});
const create = (def: InventoryDefinition, clock?: () => Date) =>
  new ProviderInventoryService({
    definitions: [def],
    cachePath: join(root, 'cache.json'),
    logger,
    onChange: () => Promise.resolve(),
    ...(clock ? { clock, ttlMs: 100 } : {}),
  });

describe('Desktop public inventory/cache/freshness', () => {
  it('restores only stale metadata and blocks configured legacy resources after expiry/failure', async () => {
    let now = new Date('2026-10-07T00:00:00.000Z');
    const fetch = vi
      .fn<InventoryDefinition['source']['fetch']>()
      .mockResolvedValue(success('fresh-model'));
    const service = create(definition(fetch), () => now);
    expect(service.descriptors()).toEqual([]);
    const refreshed = await service.refresh('chatgpt-plan');
    expect(refreshed.refreshing).toBe(false);
    expect(service.isModelAvailable('chatgpt-plan', chatGptPlanModelResource('fresh-model'))).toBe(
      true,
    );
    const restored = create(definition(fetch));
    await restored.restore();
    expect(restored.snapshot('chatgpt-plan')).toMatchObject({
      status: 'stale',
      observedAt: now.toISOString(),
    });
    expect(restored.descriptors()).toEqual([]);
    restored.dispose();
    now = new Date(now.getTime() + 101);
    expect(service.isModelAvailable('chatgpt-plan', chatGptPlanModelResource('fresh-model'))).toBe(
      false,
    );
    fetch.mockRejectedValueOnce(new Error('BODY-TOKEN-CANARY'));
    const failed = await service.refresh('chatgpt-plan');
    expect(failed.inventory).toMatchObject({
      status: 'stale',
      observedAt: '2026-10-07T00:00:00.000Z',
    });
    expect(JSON.stringify(failed)).not.toContain('BODY-TOKEN-CANARY');
    service.dispose();
  });

  it('empty authoritative refresh removes resources and disconnect discards late account results', async () => {
    let finish!: (value: InventorySourceResult) => void;
    const fetch = vi
      .fn<InventoryDefinition['source']['fetch']>()
      .mockResolvedValueOnce(success('old'))
      .mockResolvedValueOnce({ ...success('unused'), entries: [] })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    const service = create(definition(fetch));
    await service.refresh('chatgpt-plan');
    const originalId = service.descriptors()[0]!.id;
    await service.refresh('chatgpt-plan');
    expect(service.descriptors()).toEqual([]);
    const pending = service.refresh('chatgpt-plan');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    service.invalidate('chatgpt-plan');
    finish(success('old'));
    await pending;
    expect(service.descriptors()).toEqual([]);
    fetch.mockResolvedValueOnce(success('old'));
    await service.refresh('chatgpt-plan');
    expect(service.descriptors()[0]!.id).toBe(originalId);
    expect(JSON.parse(await readFile(join(root, 'cache.json'), 'utf8'))).toMatchObject({
      version: 1,
    });
    service.dispose();
  });

  it('starts a new metadata refresh when a model is rejected during an existing refresh', async () => {
    let finish!: (value: InventorySourceResult) => void;
    const fetch = vi
      .fn<InventoryDefinition['source']['fetch']>()
      .mockResolvedValueOnce(success('old'))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(success('replacement'));
    const service = create(definition(fetch));
    await service.refresh('chatgpt-plan');
    const pending = service.refresh('chatgpt-plan');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    service.rejectModel('chatgpt-plan');
    await service.refresh('chatgpt-plan');
    finish(success('old'));
    await pending;
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(service.snapshot('chatgpt-plan').entries[0]?.selection).toEqual({
      kind: 'model',
      id: 'replacement',
    });
    service.dispose();
    await service.flush();
  });

  it('does not resume an old account descriptor or accept its late rejection after reconnect', async () => {
    const fetch = vi
      .fn<InventoryDefinition['source']['fetch']>()
      .mockResolvedValue(success('same-model'));
    const service = create(definition(fetch));
    await service.refresh('chatgpt-plan');
    const old = service.descriptors()[0]!;
    service.invalidate('chatgpt-plan');
    await service.refresh('chatgpt-plan');
    const current = service.descriptors()[0]!;
    expect(current.id).toBe(old.id);
    expect(service.isAvailable(old)).toBe(false);
    expect(service.isModelAvailable('chatgpt-plan', old)).toBe(false);
    expect(service.isAvailable(current)).toBe(true);
    service.rejectResource(old);
    expect(service.snapshot('chatgpt-plan').status).toBe('fresh');
    expect(fetch).toHaveBeenCalledTimes(2);
    service.dispose();
    await service.flush();
  });

  it('rejects extra IPC/cache fields and corrupt caches without rewriting owner data', async () => {
    expect(
      InventoryArgsSchema.safeParse({ sourceId: 'chatgpt-plan', accessToken: 'CANARY' }).success,
    ).toBe(false);
    expect(InventoryArgsSchema.safeParse({ sourceId: 'arbitrary-command' }).success).toBe(false);
    expect(
      InventoryCacheSchema.safeParse({ version: 1, inventories: [], accessToken: 'CANARY' })
        .success,
    ).toBe(false);
    const path = join(root, 'cache.json');
    const raw = '{"version":999,"secret":"CANARY"}';
    await writeFile(path, raw);
    const service = create(definition(() => Promise.resolve(success('new'))));
    await service.restore();
    expect(service.descriptors()).toEqual([]);
    expect(await readFile(path, 'utf8')).toBe(raw);
    service.dispose();
  });
});
