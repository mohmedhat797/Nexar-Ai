import { describe, expect, it } from 'vitest';
import { KNOWN_TASK_KINDS } from '@nexar/contracts';
import type { OperatingMode } from '@nexar/sessions';
import { LANE_POLICY, affinityLane, confirmLane, decideLane } from './router.js';
import type { LaneAvailability } from './router.js';

const MODES: readonly OperatingMode[] = ['cowork', 'code'];
const AVAILABILITY: readonly LaneAvailability[] = [
  { cowork: false, code: false },
  { cowork: true, code: false },
  { cowork: false, code: true },
  { cowork: true, code: true },
];

describe('lanes@1 decideLane', () => {
  describe('affinity', () => {
    it.each(MODES)('maps kinds to lanes in %s mode', (mode) => {
      expect(affinityLane('coding', mode)).toBe('code');
      expect(affinityLane('review', mode)).toBe('code');
      expect(affinityLane('documentation', mode)).toBe('cowork');
      expect(affinityLane('meeting-preparation', mode)).toBe('cowork');
      for (const kind of ['analysis', 'research', 'automation', 'general', 'custom']) {
        expect(affinityLane(kind, mode)).toBe(mode);
      }
    });
  });

  describe('mode x kind x availability table', () => {
    const cases = MODES.flatMap((mode) =>
      KNOWN_TASK_KINDS.flatMap((kind) =>
        AVAILABILITY.map((available) => ({ mode, kind, available })),
      ),
    );

    it.each(cases)('$mode / $kind / $available', ({ mode, kind, available }) => {
      const out = decideLane({ mode, intent: { kind }, available });
      const requested = affinityLane(kind, mode);
      const { decision } = out;

      expect(decision.policy).toBe(LANE_POLICY);
      expect(decision.mode).toBe(mode);
      expect(decision.requestedLane).toBe(requested);

      if (kind === 'coding' && requested === 'code' && !available.code) {
        expect(out.action).toBe('refuse');
        expect(out.refusal).toEqual({
          code: 'SANDBOX_UNAVAILABLE',
          message:
            'Engineering changes need the Code lane (WSL2 engineering plane), which is not available yet.',
        });
        expect(decision.effectiveLane).toBe('code');
        expect(decision.fallbackReason).toBe('code-lane-unavailable');
        return;
      }

      expect(out.refusal).toBeUndefined();
      expect(out.action).toBe(requested === mode ? 'run' : 'confirm');
      if (requested === mode) expect(decision.mismatch).toBeUndefined();
      else expect(decision.mismatch).toEqual({ from: mode, to: requested });

      const lane = requested === 'direct' ? true : available[requested];
      if (lane) {
        expect(decision.effectiveLane).toBe(requested);
        expect(decision.fallbackReason).toBeUndefined();
      } else {
        expect(decision.effectiveLane).toBe('direct');
        expect(decision.fallbackReason).toBe('orchestrator-unavailable');
      }
      expect(decision.confirmed).toBeUndefined();
    });
  });

  it('refuses engineering writes before asking for any confirmation', () => {
    const out = decideLane({
      mode: 'cowork',
      intent: { kind: 'coding' },
      available: { cowork: true, code: false },
    });
    expect(out.action).toBe('refuse');
    expect(out.decision.mismatch).toEqual({ from: 'cowork', to: 'code' });
  });

  it('asks to confirm a coding turn in cowork mode when the code lane exists', () => {
    const out = decideLane({
      mode: 'cowork',
      intent: { kind: 'coding' },
      available: { cowork: false, code: true },
    });
    expect(out.action).toBe('confirm');
    expect(out.decision.effectiveLane).toBe('code');
  });

  it('never fails a read/draft turn: documentation in code mode falls back to direct', () => {
    const out = decideLane({
      mode: 'code',
      intent: { kind: 'documentation' },
      available: { cowork: false, code: false },
    });
    expect(out.action).toBe('confirm');
    expect(out.decision).toMatchObject({
      requestedLane: 'cowork',
      effectiveLane: 'direct',
      fallbackReason: 'orchestrator-unavailable',
    });
  });

  it('is pure and never exposes resource ids or changes the mode', () => {
    for (const mode of MODES) {
      for (const kind of KNOWN_TASK_KINDS) {
        for (const available of AVAILABILITY) {
          const input = { mode, intent: { kind }, available } as const;
          const a = decideLane(input);
          expect(decideLane(input)).toEqual(a);
          expect(a.decision.mode).toBe(mode);
          expect(JSON.stringify(a)).not.toMatch(/resource/i);
          expect(Object.keys(a.decision).sort()).toEqual(
            expect.arrayContaining(['policy', 'mode', 'requestedLane', 'effectiveLane']),
          );
          for (const key of Object.keys(a.decision)) {
            expect([
              'policy',
              'mode',
              'requestedLane',
              'effectiveLane',
              'mismatch',
              'fallbackReason',
            ]).toContain(key);
          }
        }
      }
    }
  });
});

describe('lanes@1 confirmLane', () => {
  const pending = decideLane({
    mode: 'cowork',
    intent: { kind: 'coding' },
    available: { cowork: true, code: true },
  }).decision;

  it('runs a confirmed mismatch and keeps the mode', () => {
    const out = confirmLane(pending, { cowork: true, code: true }, { kind: 'coding' });
    expect(out.action).toBe('run');
    expect(out.decision).toMatchObject({ confirmed: true, mode: 'cowork', effectiveLane: 'code' });
    expect(out.decision.fallbackReason).toBeUndefined();
    expect(out.decision.mismatch).toEqual({ from: 'cowork', to: 'code' });
  });

  it('refuses an engineering write when the code lane disappeared while pending', () => {
    const out = confirmLane(pending, { cowork: true, code: false }, { kind: 'coding' });
    expect(out.action).toBe('refuse');
    expect(out.refusal?.code).toBe('SANDBOX_UNAVAILABLE');
    expect(out.decision).toMatchObject({
      confirmed: true,
      effectiveLane: 'code',
      fallbackReason: 'code-lane-unavailable',
    });
  });

  it('re-evaluates fallback for read/draft work and drops a stale fallback reason', () => {
    const doc = decideLane({
      mode: 'code',
      intent: { kind: 'documentation' },
      available: { cowork: false, code: true },
    }).decision;
    expect(doc.fallbackReason).toBe('orchestrator-unavailable');

    const later = confirmLane(doc, { cowork: true, code: true }, { kind: 'documentation' });
    expect(later.action).toBe('run');
    expect(later.decision.effectiveLane).toBe('cowork');
    expect(later.decision.fallbackReason).toBeUndefined();

    const still = confirmLane(doc, { cowork: false, code: true }, { kind: 'documentation' });
    expect(still.decision).toMatchObject({
      effectiveLane: 'direct',
      fallbackReason: 'orchestrator-unavailable',
      confirmed: true,
    });
  });

  it('never changes the mode, whatever the availability', () => {
    for (const available of AVAILABILITY) {
      expect(confirmLane(pending, available, { kind: 'coding' }).decision.mode).toBe('cowork');
    }
  });

  it('lets a confirmed read-only review fall back to direct instead of refusing', () => {
    const review = decideLane({
      mode: 'cowork',
      intent: { kind: 'review' },
      available: { cowork: true, code: false },
    });
    expect(review.action).toBe('confirm');
    expect(review.decision.mismatch).toEqual({ from: 'cowork', to: 'code' });
    const out = confirmLane(review.decision, { cowork: true, code: false }, { kind: 'review' });
    expect(out.action).toBe('run');
    expect(out.decision).toMatchObject({
      confirmed: true,
      effectiveLane: 'direct',
      fallbackReason: 'orchestrator-unavailable',
    });
  });
});
