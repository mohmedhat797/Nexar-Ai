import type { QuotaObservation, ResourceId } from '@nexar/contracts';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESOURCE_INTELLIGENCE_SETTINGS,
  type ReservationRule,
} from './intelligence-settings.js';
import { assessQuota, evaluateQuota } from './quota.js';

const NOW = new Date('2026-10-01T12:00:00.000Z');
const settings = DEFAULT_RESOURCE_INTELLIGENCE_SETTINGS.quota;
const MIN = 60_000;

const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const later = (ms: number): string => new Date(NOW.getTime() + ms).toISOString();

const declared = (extra: Partial<QuotaObservation> = {}): QuotaObservation => ({
  unit: 'requests',
  limit: 100,
  used: 40,
  remaining: 60,
  observedAt: NOW.toISOString(),
  provenance: { limit: 'owner-declared', usage: 'nexar-accounting' },
  ...extra,
});

const vendor = (extra: Partial<QuotaObservation> = {}): QuotaObservation => ({
  unit: 'percent',
  limit: 100,
  used: 20,
  remaining: 80,
  observedAt: NOW.toISOString(),
  provenance: { limit: 'vendor-reported', usage: 'vendor-reported' },
  ...extra,
});

function withoutRemaining(o: QuotaObservation): QuotaObservation {
  const rest: { -readonly [K in keyof QuotaObservation]: QuotaObservation[K] } = { ...o };
  delete rest.remaining;
  return rest;
}

describe('assessQuota', () => {
  it('is unknown without observations', () => {
    expect(assessQuota(undefined, NOW, settings)).toEqual({ freshness: 'unknown', sources: [] });
    expect(assessQuota([], NOW, settings).freshness).toBe('unknown');
  });

  it('is exhausted when nothing remains, reporting the reset', () => {
    const resetsAt = later(2 * 60 * MIN);
    const a = assessQuota([declared({ used: 100, remaining: 0, resetsAt })], NOW, settings);
    expect(a).toEqual({
      freshness: 'exhausted',
      headroom: 0,
      resetsAt,
      sources: ['nexar-accounting+owner-declared'],
    });
  });

  it('detects exhaustion from used >= limit alone', () => {
    const a = assessQuota([withoutRemaining(declared({ used: 100 }))], NOW, settings);
    expect(a.freshness).toBe('exhausted');
  });

  it('does not let a stale exhausted vendor signal without a reset time block forever', () => {
    const noReset = vendor({ remaining: 0, used: 100, observedAt: ago(2 * 60 * MIN) });
    const signal = noReset;
    expect(assessQuota([noReset], NOW, settings).freshness).toBe('known-stale');
    // A fresh one still rejects, and a stale one with a future reset still holds until then.
    expect(assessQuota([{ ...noReset, observedAt: ago(MIN) }], NOW, settings).freshness).toBe(
      'exhausted',
    );
    expect(assessQuota([{ ...signal, resetsAt: later(30 * MIN) }], NOW, settings).freshness).toBe(
      'exhausted',
    );
  });

  it('is unknown once the reset has passed', () => {
    const a = assessQuota(
      [declared({ used: 100, remaining: 0, resetsAt: ago(MIN) })],
      NOW,
      settings,
    );
    expect(a.freshness).toBe('unknown');
    // The boundary instant counts as reset.
    const edge = assessQuota(
      [declared({ used: 100, remaining: 0, resetsAt: NOW.toISOString() })],
      NOW,
      settings,
    );
    expect(edge.freshness).toBe('unknown');
  });

  it('is known-current near exhaustion', () => {
    const a = assessQuota([declared({ used: 99, remaining: 1 })], NOW, settings);
    expect(a.freshness).toBe('known-current');
    expect(a.headroom).toBeCloseTo(0.01);
  });

  it('derives headroom from used when remaining is absent', () => {
    const a = assessQuota([withoutRemaining(declared({ used: 25 }))], NOW, settings);
    expect(a.headroom).toBeCloseTo(0.75);
  });

  it('treats owner-declared + accounting as current however old observedAt is', () => {
    const a = assessQuota([declared({ observedAt: ago(48 * 60 * MIN) })], NOW, settings);
    expect(a.freshness).toBe('known-current');
    expect(a.sources).toEqual(['nexar-accounting+owner-declared']);
  });

  it('marks an old vendor observation stale, but a fresh one current', () => {
    const stale = assessQuota(
      [vendor({ observedAt: ago(settings.staleAfterMs + 1) })],
      NOW,
      settings,
    );
    expect(stale).toEqual({ freshness: 'known-stale', sources: ['vendor-reported'] });
    expect(stale.headroom).toBeUndefined();
    const fresh = assessQuota([vendor({ observedAt: ago(settings.staleAfterMs) })], NOW, settings);
    expect(fresh.freshness).toBe('known-current');
    expect(fresh.headroom).toBeCloseTo(0.8);
  });

  it('still rejects on a stale exhausted value until its reset', () => {
    const o = vendor({
      used: 100,
      remaining: 0,
      observedAt: ago(5 * 60 * MIN),
      resetsAt: later(MIN),
    });
    expect(assessQuota([o], NOW, settings).freshness).toBe('exhausted');
    expect(assessQuota([o], new Date(NOW.getTime() + 2 * MIN), settings).freshness).toBe('unknown');
  });

  it('takes the minimum headroom of current observations and ignores stale ones for it', () => {
    const a = assessQuota(
      [
        declared({ used: 40, remaining: 60 }),
        vendor({ used: 70, remaining: 30 }),
        vendor({
          used: 99,
          remaining: 1,
          observedAt: ago(settings.staleAfterMs * 2),
          label: 'old',
        }),
      ],
      NOW,
      settings,
    );
    expect(a.freshness).toBe('known-current');
    expect(a.headroom).toBeCloseTo(0.3);
    expect(a.sources).toEqual(['nexar-accounting+owner-declared', 'vendor-reported']);
  });

  it('lets any exhausted observation win and reports the earliest reset', () => {
    const a = assessQuota(
      [
        declared({ used: 100, remaining: 0, resetsAt: later(120 * MIN) }),
        vendor({ used: 100, remaining: 0, resetsAt: later(30 * MIN) }),
        declared({ used: 1, remaining: 99 }),
      ],
      NOW,
      settings,
    );
    expect(a.freshness).toBe('exhausted');
    expect(a.resetsAt).toBe(later(30 * MIN));
  });

  it('sums unaccounted runs', () => {
    const a = assessQuota(
      [declared({ unaccountedRuns: 2 }), declared({ unaccountedRuns: 3, unit: 'tokens' })],
      NOW,
      settings,
    );
    expect(a.unaccountedRuns).toBe(5);
    expect(assessQuota([declared()], NOW, settings).unaccountedRuns).toBeUndefined();
  });

  it.each([
    ['NaN used', { used: Number.NaN, remaining: undefined }],
    ['negative limit', { limit: -5, used: undefined, remaining: 3 }],
    ['infinite limit', { limit: Number.POSITIVE_INFINITY, used: 1, remaining: undefined }],
    ['infinite remaining', { limit: 10, used: undefined, remaining: Number.POSITIVE_INFINITY }],
    ['zero limit', { limit: 0, used: undefined, remaining: 3 }],
    ['no figures', { limit: undefined, used: undefined, remaining: undefined }],
  ] as const)('ignores invalid numbers (%s)', (_name, patch) => {
    const o = { ...declared(), ...patch } as unknown as QuotaObservation;
    expect(assessQuota([o], NOW, settings).freshness).toBe('unknown');
  });

  it('ignores a negative remaining without calling the window exhausted', () => {
    const a = assessQuota([declared({ remaining: -1, used: 10 })], NOW, settings);
    expect(a.freshness).toBe('known-current');
    expect(a.headroom).toBeCloseTo(0.9);
  });

  it('does not mutate its input', () => {
    const input = [declared()];
    const copy = structuredClone(input);
    assessQuota(input, NOW, settings);
    expect(input).toEqual(copy);
  });
});

const reservation: ReservationRule = {
  resourceId: 'claude-code' as ResourceId,
  reserveFraction: 0.3,
  reservedFor: { taskKinds: ['review'], laneRoles: ['review', 'architecture'] },
};

const current = (headroom: number) => {
  const remaining = Math.round(headroom * 100);
  return assessQuota([declared({ limit: 100, used: 100 - remaining, remaining })], NOW, settings);
};

const codes = (r: { reasons: { code: string }[] }): string[] => r.reasons.map((x) => x.code);

describe('evaluateQuota', () => {
  it('supports a resource with known headroom', () => {
    const r = evaluateQuota(current(0.62), { taskKind: 'general' }, undefined, settings);
    expect(r.rejected).toBe(false);
    expect(r.reasons).toEqual([
      { code: 'quota.ok', message: 'quota headroom 62%', effect: 'supports' },
    ]);
    expect(r.factor).toEqual({ value: 0.62, neutral: false });
    expect(r.assessment.reservation).toBeUndefined();
  });

  it('rejects an exhausted resource and names the reset', () => {
    const a = assessQuota(
      [declared({ used: 100, remaining: 0, resetsAt: later(MIN) })],
      NOW,
      settings,
    );
    const r = evaluateQuota(a, { taskKind: 'general' }, reservation, settings);
    expect(codes(r)).toEqual(['quota.exhausted']);
    expect(r.rejected).toBe(true);
    expect(r.reasons[0]?.message).toContain(later(MIN));
    expect(r.factor).toEqual({ value: 0, neutral: false });
    const noReset = evaluateQuota(
      assessQuota([declared({ used: 100, remaining: 0 })], NOW, settings),
      { taskKind: 'general' },
      undefined,
      settings,
    );
    expect(noReset.reasons[0]?.message).toBe('quota exhausted');
  });

  it('is neutral about unknown quota by default', () => {
    const r = evaluateQuota(
      assessQuota(undefined, NOW, settings),
      { taskKind: 'x' },
      undefined,
      settings,
    );
    expect(codes(r)).toEqual(['quota.unknown']);
    expect(r.rejected).toBe(false);
    expect(r.factor).toEqual({ value: settings.unknownScore, neutral: true });
  });

  it('is neutral about stale quota by default', () => {
    const stale = assessQuota(
      [vendor({ observedAt: ago(settings.staleAfterMs * 2) })],
      NOW,
      settings,
    );
    const r = evaluateQuota(stale, { taskKind: 'x' }, undefined, {
      ...settings,
      unknownScore: 0.4,
    });
    expect(codes(r)).toEqual(['quota.stale']);
    expect(r.factor).toEqual({ value: 0.4, neutral: true });
  });

  it.each([
    ['unknown', assessQuota(undefined, NOW, settings)],
    [
      'known-stale',
      assessQuota([vendor({ observedAt: ago(settings.staleAfterMs * 2) })], NOW, settings),
    ],
  ])('rejects %s quota when known quota is required', (_name, a) => {
    const r = evaluateQuota(a, { taskKind: 'x', requireKnownQuota: true }, undefined, settings);
    expect(codes(r)).toEqual(['quota.unknown-strict']);
    expect(r.rejected).toBe(true);
  });

  it('accepts current quota when known quota is required', () => {
    const r = evaluateQuota(
      current(0.5),
      { taskKind: 'x', requireKnownQuota: true },
      undefined,
      settings,
    );
    expect(r.rejected).toBe(false);
  });

  describe('reservation', () => {
    it('protects the reserve from routine kinds', () => {
      const r = evaluateQuota(current(0.24), { taskKind: 'general' }, reservation, settings);
      expect(r.rejected).toBe(true);
      expect(codes(r)).toEqual(['quota.reserved']);
      expect(r.reasons[0]?.message).toBe('headroom 24% ≤ reserved 30% for review, architecture');
      expect(r.assessment.reservation).toEqual({
        reserveFraction: 0.3,
        protected: true,
        verifiable: true,
      });
    });

    it('protects at exactly the reserve fraction', () => {
      const r = evaluateQuota(current(0.3), { taskKind: 'general' }, reservation, settings);
      expect(codes(r)).toEqual(['quota.reserved']);
    });

    it('does not protect above the reserve', () => {
      const r = evaluateQuota(current(0.31), { taskKind: 'general' }, reservation, settings);
      expect(r.rejected).toBe(false);
      expect(codes(r)).toEqual(['quota.ok']);
      expect(r.assessment.reservation).toEqual({
        reserveFraction: 0.3,
        protected: false,
        verifiable: true,
      });
    });

    it('lets a reserved task kind use the reserve', () => {
      const r = evaluateQuota(current(0.1), { taskKind: 'review' }, reservation, settings);
      expect(r.rejected).toBe(false);
      expect(codes(r)).toEqual(['quota.reserved-for-task', 'quota.ok']);
      expect(r.reasons[0]?.effect).toBe('supports');
      expect(r.assessment.reservation?.protected).toBe(false);
    });

    it('lets a reserved lane role use the reserve', () => {
      const r = evaluateQuota(
        current(0.1),
        { taskKind: 'coding', laneRole: 'architecture' },
        reservation,
        settings,
      );
      expect(r.rejected).toBe(false);
      expect(codes(r)).toContain('quota.reserved-for-task');
      const other = evaluateQuota(
        current(0.1),
        { taskKind: 'coding', laneRole: 'feature' },
        reservation,
        settings,
      );
      expect(other.rejected).toBe(true);
    });

    it('is unverifiable when quota is unknown or stale, and does not reject', () => {
      for (const a of [
        assessQuota(undefined, NOW, settings),
        assessQuota([vendor({ observedAt: ago(settings.staleAfterMs * 2) })], NOW, settings),
      ]) {
        const r = evaluateQuota(a, { taskKind: 'general' }, reservation, settings);
        expect(r.rejected).toBe(false);
        expect(codes(r)).toContain('quota.reservation-unverifiable');
        expect(r.factor.neutral).toBe(true);
        expect(r.assessment.reservation).toEqual({
          reserveFraction: 0.3,
          protected: false,
          verifiable: false,
        });
      }
    });

    it('still rejects unverifiable reservations under strict mode', () => {
      const r = evaluateQuota(
        assessQuota(undefined, NOW, settings),
        { taskKind: 'general', requireKnownQuota: true },
        reservation,
        settings,
      );
      expect(r.rejected).toBe(true);
      expect(codes(r)).toEqual(['quota.unknown-strict', 'quota.reservation-unverifiable']);
    });
  });

  it('is deterministic', () => {
    const a = current(0.2);
    const ctx = { taskKind: 'general' };
    expect(evaluateQuota(a, ctx, reservation, settings)).toEqual(
      evaluateQuota(a, ctx, reservation, settings),
    );
  });
});
