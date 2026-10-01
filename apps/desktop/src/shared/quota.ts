import type { QuotaAssessment } from '@nexar/contracts';

/** `2026-10-02T00:00Z`: minute precision is enough for a reset time. */
function shortTime(iso: string): string {
  return iso.replace(/:\d{2}(\.\d+)?Z$/, 'Z');
}

/**
 * `unknown`, `stale`, `62% left · resets 2026-10-02T00:00Z · owner-declared+nexar-accounting` or
 * `exhausted until …`: the same wording as `nexar resources`. Never a fake number for unknown.
 */
export function describeQuota(a: QuotaAssessment): string {
  const resets = a.resetsAt === undefined ? [] : [`resets ${shortTime(a.resetsAt)}`];
  const source = a.sources.length === 0 ? [] : [a.sources.join(',')];
  switch (a.freshness) {
    case 'unknown':
      return 'unknown';
    case 'known-stale':
      return 'stale';
    case 'exhausted':
      return a.resetsAt === undefined ? 'exhausted' : `exhausted until ${shortTime(a.resetsAt)}`;
    case 'known-current':
      return [`${String(Math.round((a.headroom ?? 0) * 100))}% left`, ...resets, ...source].join(
        ' · ',
      );
  }
}
