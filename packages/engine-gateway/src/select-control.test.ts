import { describe, expect, it } from 'vitest';
import { NexarError, type ControlResourcePolicy } from '@nexar/contracts';
import { NOW, routingPolicy, snap } from './fixtures.js';
import { selectControl, type SelectControlInput } from './select-control.js';

let counter = 0;
const newId = (): string => `d${String(++counter)}`;

function select(
  candidates: SelectControlInput['candidates'],
  policy: ControlResourcePolicy,
  extra: Partial<SelectControlInput> = {},
) {
  return selectControl({
    engine: 'openworker',
    policy,
    candidates,
    routingPolicy: routingPolicy(),
    now: NOW,
    newId,
    ...extra,
  });
}

const auto: ControlResourcePolicy = { mode: 'auto', fallback: 'auto' };
const agent = (id: string) =>
  snap(id, {
    kind: { type: 'agent', agent: 'claude-code', interface: 'cli' },
    capabilities: ['text-generation', 'knowledge-work', 'reasoning'],
  });
const experimental = (id: string) =>
  snap(id, {
    metadata: {
      connection: {
        id: 'x.sub',
        provider: 'x',
        method: 'subscription',
        authClass: 'experimental-client-compat',
        support: 'experimental',
      },
    },
  });

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof NexarError ? e.code : 'other';
  }
  return undefined;
}

describe('selectControl', () => {
  it('auto picks a model-turn resource and never a native agent', () => {
    const d = select([agent('native'), snap('api-a')], auto);
    expect(d.resourceId).toBe('api-a');
    expect(d.engine).toBe('openworker');
    expect(d.reasonCodes).toContain('control.auto');
    expect(d.decidedAt).toBe(NOW.toISOString());
    expect(d.controlDecisionId).toMatch(/^d\d+$/);
  });

  it('fails with NO_ELIGIBLE_RESOURCE when only native agents exist', () => {
    expect(codeOf(() => select([agent('native')], auto))).toBe('NO_ELIGIBLE_RESOURCE');
  });

  it('excludes experimental connections unless the strategy allows them', () => {
    expect(codeOf(() => select([experimental('exp')], auto))).toBe('NO_ELIGIBLE_RESOURCE');
    const d = select([experimental('exp')], auto, {
      strategySettings: { allowExperimental: true },
    });
    expect(d.resourceId).toBe('exp');
  });

  it('lists the other eligible resources as alternatives', () => {
    const d = select([snap('a'), snap('b'), agent('native')], auto);
    expect([d.resourceId, ...d.alternatives].sort()).toEqual(['a', 'b']);
  });

  it('honours a pinned, eligible resource', () => {
    const d = select([snap('a'), snap('b')], { mode: 'pinned', resourceId: 'b', fallback: 'none' });
    expect(d.resourceId).toBe('b');
    expect(d.alternatives).toEqual(['a']);
    expect(d.reasonCodes).toEqual(['control.pinned']);
  });

  it('pinned but unavailable: fallback auto records the reason', () => {
    const pinned = { mode: 'pinned', resourceId: 'gone', fallback: 'auto' } as const;
    const d = select([snap('a')], pinned);
    expect(d.resourceId).toBe('a');
    expect(d.reasonCodes).toContain('control.pinned-unavailable');
  });

  it('pinned resource that is not control-compatible counts as unavailable', () => {
    const pinned = { mode: 'pinned', resourceId: 'native', fallback: 'none' } as const;
    expect(codeOf(() => select([agent('native'), snap('a')], pinned))).toBe('NO_ELIGIBLE_RESOURCE');
    expect(select([agent('native'), snap('a')], { ...pinned, fallback: 'auto' }).resourceId).toBe(
      'a',
    );
  });

  it('pinned unavailable with fallback none reports the reason code', () => {
    try {
      select([snap('a')], { mode: 'pinned', resourceId: 'gone', fallback: 'none' });
      expect.unreachable();
    } catch (e) {
      expect((e as NexarError).code).toBe('NO_ELIGIBLE_RESOURCE');
      expect((e as NexarError).details?.reasonCodes).toEqual(['control.pinned-unavailable']);
    }
  });

  it('a pinned policy without a resource id is a validation error', () => {
    expect(codeOf(() => select([snap('a')], { mode: 'pinned', fallback: 'auto' }))).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('never selects an excluded resource', () => {
    const d = select(
      [snap('a'), snap('b')],
      { mode: 'pinned', resourceId: 'a', fallback: 'auto' },
      { exclude: ['a'] },
    );
    expect(d.resourceId).toBe('b');
  });

  it('skips unavailable resources', () => {
    const d = select([snap('down', {}, { availability: 'unavailable' }), snap('up')], auto);
    expect(d.resourceId).toBe('up');
  });
});
