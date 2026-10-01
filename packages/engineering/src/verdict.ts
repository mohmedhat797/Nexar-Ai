export type FindingSeverity = 'blocker' | 'major' | 'minor' | 'nit';

export interface ReviewFinding {
  readonly severity: FindingSeverity;
  readonly file?: string;
  readonly message: string;
}

export interface ReviewVerdict {
  readonly verdict: 'approve' | 'request-changes';
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
  /** False when the reply could not be turned into a valid verdict (the review failed closed). */
  readonly valid: boolean;
}

const SEVERITIES: readonly string[] = ['blocker', 'major', 'minor', 'nit'];
const MAX_SCAN_CHARS = 1024 * 1024;
const MAX_ATTEMPTS = 5000;
const MAX_FINDINGS = 100;
const MAX_TEXT = 2000;

const fail = (code: string): ReviewVerdict => ({
  verdict: 'request-changes',
  summary: code,
  findings: [{ severity: 'major', message: code }],
  valid: false,
});

/** End index of the balanced `{…}` starting at `start`, honouring JSON strings; -1 if none. */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

/** The last JSON object in `text` (plain, fenced or followed by prose) that mentions a verdict. */
function lastVerdictObject(text: string): Record<string, unknown> | undefined {
  const scanned = text.length > MAX_SCAN_CHARS ? text.slice(-MAX_SCAN_CHARS) : text;
  let found: Record<string, unknown> | undefined;
  let attempts = 0;
  for (let i = scanned.indexOf('{'); i !== -1; i = scanned.indexOf('{', i + 1)) {
    if (++attempts > MAX_ATTEMPTS) break;
    const end = balancedEnd(scanned, i);
    if (end === -1) continue;
    let value: unknown;
    try {
      value = JSON.parse(scanned.slice(i, end + 1));
    } catch {
      continue;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    // Skip what is nested inside this object; only top-level objects compete for "last".
    i = end;
    if ('verdict' in value) found = value;
  }
  return found;
}

/**
 * Turns a review lane's reply into a verdict. Fails closed: anything that is not a well-formed
 * verdict is `request-changes` with the synthetic finding `review.unparseable`, and an `approve`
 * that lists blocker or major findings is contradictory and is also not accepted.
 */
export function parseReviewVerdict(text: string): ReviewVerdict {
  const object = lastVerdictObject(text);
  if (object === undefined) return fail('review.unparseable');
  const verdict = object['verdict'];
  if (verdict !== 'approve' && verdict !== 'request-changes') return fail('review.unparseable');
  const summary = object['summary'];
  if (summary !== undefined && typeof summary !== 'string') return fail('review.unparseable');
  const rawFindings = object['findings'] ?? [];
  if (!Array.isArray(rawFindings) || rawFindings.length > MAX_FINDINGS) {
    return fail('review.unparseable');
  }
  const findings: ReviewFinding[] = [];
  for (const raw of rawFindings as unknown[]) {
    if (typeof raw !== 'object' || raw === null) return fail('review.unparseable');
    const { severity, file, message } = raw as Record<string, unknown>;
    if (typeof severity !== 'string' || !SEVERITIES.includes(severity)) {
      return fail('review.unparseable');
    }
    if (typeof message !== 'string' || message.trim() === '') return fail('review.unparseable');
    if (file !== undefined && typeof file !== 'string') return fail('review.unparseable');
    findings.push({
      severity: severity as FindingSeverity,
      ...(file === undefined ? {} : { file: file.slice(0, 500) }),
      message: message.slice(0, MAX_TEXT),
    });
  }
  const blocking = findings.some((f) => f.severity === 'blocker' || f.severity === 'major');
  if (verdict === 'approve' && blocking) {
    return {
      verdict: 'request-changes',
      summary: 'review.inconsistent',
      findings: [
        ...findings,
        { severity: 'major', message: 'review.inconsistent: approve with blocker/major findings' },
      ],
      valid: false,
    };
  }
  return {
    verdict,
    summary: (summary ?? '').slice(0, MAX_TEXT),
    findings,
    valid: true,
  };
}
