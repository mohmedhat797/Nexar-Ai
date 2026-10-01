import { isNexarError } from '@nexar/contracts';
import type { NexarError } from '@nexar/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeCodeResource, findRateLimit, parseRateLimitEvent } from './index.js';
import { harness, task } from './test/harness.js';
import type { Harness } from './test/harness.js';

const NOW = new Date('2026-10-01T12:00:00.000Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);

const line = (info: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info, ...extra });

describe('parseRateLimitEvent', () => {
  it('maps the documented shape', () => {
    const parsed = parseRateLimitEvent(
      line({ status: 'allowed_warning', utilization: 0.62, resetsAt: NOW_S + 3600 }),
      NOW,
    );
    expect(parsed?.rejected).toBe(false);
    expect(parsed?.observation).toEqual({
      unit: 'percent',
      limit: 100,
      used: 62,
      remaining: 38,
      resetsAt: '2026-10-01T13:00:00.000Z',
      observedAt: NOW.toISOString(),
      provenance: { limit: 'vendor-reported', usage: 'vendor-reported' },
      label: 'claude-rate-limit',
    });
  });

  it('treats a rejected status as fully used and clamps utilization', () => {
    expect(parseRateLimitEvent(line({ status: 'rejected' }), NOW)?.observation).toMatchObject({
      used: 100,
      remaining: 0,
    });
    expect(
      parseRateLimitEvent(line({ status: 'allowed', utilization: 1.7 }), NOW)?.observation,
    ).toMatchObject({ used: 100, remaining: 0 });
    expect(
      parseRateLimitEvent(line({ status: 'allowed', utilization: -1 }), NOW)?.observation,
    ).toMatchObject({ used: 0, remaining: 100 });
  });

  it('reads resetsAt as seconds, or as milliseconds above 1e12', () => {
    const iso = '2026-10-01T13:00:00.000Z';
    const s = parseRateLimitEvent(line({ status: 'rejected', resetsAt: NOW_S + 3600 }), NOW);
    const ms = parseRateLimitEvent(
      line({ status: 'rejected', resetsAt: (NOW_S + 3600) * 1000 }),
      NOW,
    );
    expect(s?.observation.resetsAt).toBe(iso);
    expect(ms?.observation.resetsAt).toBe(iso);
  });

  it('drops a resetsAt outside [now - 1 day, now + 60 days]', () => {
    const day = 24 * 3600;
    for (const resetsAt of [NOW_S - 2 * day, NOW_S + 61 * day, 'soon', Number.NaN]) {
      const parsed = parseRateLimitEvent(line({ status: 'rejected', resetsAt }), NOW);
      expect(parsed?.observation.resetsAt).toBeUndefined();
    }
    const edge = parseRateLimitEvent(line({ status: 'rejected', resetsAt: NOW_S - day }), NOW);
    expect(edge?.observation.resetsAt).toBeDefined();
  });

  it('ignores undocumented fields and other event types', () => {
    const parsed = parseRateLimitEvent(
      line(
        { status: 'allowed', utilization: 0.5, rateLimitType: 'five_hour', overage: { x: 1 } },
        { unifiedWindows: [{ utilization: 0.9 }] },
      ),
      NOW,
    );
    expect(parsed?.observation.used).toBe(50);
    expect(JSON.stringify(parsed)).not.toMatch(/five_hour|overage|unifiedWindows/);
    expect(parseRateLimitEvent(JSON.stringify({ type: 'assistant' }), NOW)).toBeUndefined();
    expect(parseRateLimitEvent('not json', NOW)).toBeUndefined();
    expect(
      parseRateLimitEvent(JSON.stringify({ type: 'rate_limit_event', status: 'rejected' }), NOW),
    ).toBeUndefined();
    // Neither rejected nor a utilization figure: nothing to report.
    expect(parseRateLimitEvent(line({ status: 'allowed' }), NOW)).toBeUndefined();
  });

  it('keeps the latest event of a run', () => {
    const stdout = [
      line({ status: 'allowed', utilization: 0.1 }),
      'garbage',
      line({ status: 'allowed_warning', utilization: 0.8 }),
    ].join('\n');
    expect(findRateLimit(stdout, NOW)?.observation.used).toBeCloseTo(80);
    expect(findRateLimit('{"type":"result"}', NOW)).toBeUndefined();
  });
});

describe('adapter quota signals', () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  const run = (hh: Harness) =>
    hh.adapter.execute({ task: task(), resource: claudeCodeResource() }, hh.context());

  it('returns the observation on a successful run', async () => {
    h = harness(
      { FAKE_CLAUDE_RATE_LIMIT: JSON.stringify({ status: 'allowed_warning', utilization: 0.9 }) },
      { clock: () => NOW },
    );
    const result = await run(h);
    expect(result.quotaObservations).toEqual([
      expect.objectContaining({ used: 90, label: 'claude-rate-limit' }),
    ]);
  });

  it('returns no observations without an event', async () => {
    h = harness();
    expect((await run(h)).quotaObservations).toBeUndefined();
  });

  it('maps a rejected, failed run to QUOTA_EXHAUSTED with the reset time', async () => {
    h = harness(
      {
        FAKE_CLAUDE_MODE: 'error',
        FAKE_CLAUDE_RATE_LIMIT: JSON.stringify({ status: 'rejected', resetsAt: NOW_S + 7200 }),
      },
      { clock: () => NOW },
    );
    const err = await run(h).then(
      () => undefined,
      (e: unknown) => e as NexarError,
    );
    expect(isNexarError(err)).toBe(true);
    expect(err?.code).toBe('QUOTA_EXHAUSTED');
    expect(err?.details?.['resetsAt']).toBe('2026-10-01T14:00:00.000Z');
    expect(err?.message).not.toContain('PROMPT-SENTINEL');
  });

  it('keeps PROVIDER_ERROR when the failed run was not rejected', async () => {
    h = harness({
      FAKE_CLAUDE_MODE: 'error',
      FAKE_CLAUDE_RATE_LIMIT: JSON.stringify({ status: 'allowed', utilization: 0.3 }),
    });
    const err = await run(h).then(
      () => undefined,
      (e: unknown) => e as NexarError,
    );
    expect(err?.code).toBe('PROVIDER_ERROR');
  });
});
