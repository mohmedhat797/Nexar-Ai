import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { LaneAggregate, LaneRole, RoutingHistory } from '@nexar/contracts';
import {
  RECORD_FILE,
  isTaskId,
  type CommandRecord,
  type EngineeringRecord,
  type LaneRecord,
  type ReviewRecord,
} from './record.js';

/**
 * Engineering-signal reader (ADR-020 section 8). Records are untrusted input: bounded, shape
 * guarded, never symlink-followed, never executed. Output carries resource ids, roles and counts
 * only; no prompts, diffs, gate output, paths or approval ids.
 */
export interface LaneHistoryOptions {
  /** Maximum task directories read (default 1000); the excess is counted as skipped. */
  readonly maxRecords?: number;
  /** Maximum size of one record file (default 1 MiB). */
  readonly maxRecordBytes?: number;
}

export interface LaneHistoryResult {
  readonly lanes: RoutingHistory['lanes'];
  readonly skipped: number;
}

const DEFAULT_MAX_RECORDS = 1000;
const DEFAULT_MAX_RECORD_BYTES = 1024 * 1024;
const DAY_MS = 86_400_000;
const MAX_LATENCY_MS = DAY_MS;
const MAX_COUNT = 1_000_000;
const MAX_ROUND = 10;

const IMPLEMENTER_ROLES: ReadonlySet<string> = new Set(['feature', 'tests', 'debugging']);
const KNOWN_ROLES: ReadonlySet<string> = new Set([...IMPLEMENTER_ROLES, 'review', 'architecture']);
/** Caller/policy outcomes say nothing about the resource's quality. */
const EXCLUDED_ERROR_CODES: ReadonlySet<string> = new Set([
  'VALIDATION_ERROR',
  'POLICY_REJECTED',
  'CONFIGURATION_ERROR',
  'APPROVAL_DENIED',
  'SANDBOX_UNAVAILABLE',
]);

// ---------------------------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------------------------

interface Counters {
  samples: number;
  latencies: number[];
  firstRoundGatePasses: number;
  gateSamples: number;
  reworkRounds: number;
  tasks: number;
  reviewApprovals: number;
  reviewVerdicts: number;
  ownerApprovals: number;
  ownerDecisions: number;
  validVerdicts: number;
  producedVerdicts: number;
}

type Buckets = Map<string, Map<LaneRole, Counters>>;
type Implementers = Map<string, { readonly resourceId: string; readonly role: LaneRole }>;

function counters(buckets: Buckets, resourceId: string, role: LaneRole): Counters {
  let roles = buckets.get(resourceId);
  if (roles === undefined) {
    roles = new Map();
    buckets.set(resourceId, roles);
  }
  let c = roles.get(role);
  if (c === undefined) {
    c = {
      samples: 0,
      latencies: [],
      firstRoundGatePasses: 0,
      gateSamples: 0,
      reworkRounds: 0,
      tasks: 0,
      reviewApprovals: 0,
      reviewVerdicts: 0,
      ownerApprovals: 0,
      ownerDecisions: 0,
      validVerdicts: 0,
      producedVerdicts: 0,
    };
    roles.set(role, c);
  }
  return c;
}

function clampCount(n: number): number {
  return Number.isInteger(n) && n >= 0 ? Math.min(n, MAX_COUNT) : 0;
}

function clampRound(n: number): number {
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 0), MAX_ROUND) : 0;
}

/** Nearest-rank median. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length / 2) - 1] as number;
}

function countsAsSample(lane: LaneRecord): boolean {
  if (lane.resourceId === undefined || lane.resourceId === '') return false;
  if (!KNOWN_ROLES.has(lane.role)) return false;
  if (lane.outcome === 'cancelled') return false;
  return lane.errorCode === undefined || !EXCLUDED_ERROR_CODES.has(lane.errorCode);
}

/** Distinct implementer (resourceId, role) pairs of succeeded lanes, keyed by round. */
function implementersByRound(record: EngineeringRecord): Map<number, Implementers> {
  const rounds = new Map<number, Implementers>();
  for (const lane of record.lanes) {
    if (lane.outcome !== 'succeeded' || !IMPLEMENTER_ROLES.has(lane.role)) continue;
    if (lane.resourceId === undefined || lane.resourceId === '') continue;
    let pairs = rounds.get(lane.round);
    if (pairs === undefined) {
      pairs = new Map();
      rounds.set(lane.round, pairs);
    }
    pairs.set(JSON.stringify([lane.role, lane.resourceId]), {
      resourceId: lane.resourceId,
      role: lane.role as LaneRole,
    });
  }
  return rounds;
}

function addRecord(buckets: Buckets, record: EngineeringRecord): void {
  for (const lane of record.lanes) {
    if (!countsAsSample(lane)) continue;
    const c = counters(buckets, lane.resourceId as string, lane.role as LaneRole);
    c.samples += 1;
    if (lane.outcome === 'succeeded' && Number.isFinite(lane.latencyMs)) {
      c.latencies.push(Math.min(Math.max(lane.latencyMs, 0), MAX_LATENCY_MS));
    }
  }

  const rounds = implementersByRound(record);

  const firstGates = record.commands.filter((c) => c.phase === 'gate' && c.round === 0);
  if (firstGates.length > 0) {
    const passed = firstGates.every((c) => c.passed);
    for (const { resourceId, role } of rounds.get(0)?.values() ?? []) {
      const c = counters(buckets, resourceId, role);
      c.gateSamples += 1;
      c.firstRoundGatePasses += passed ? 1 : 0;
    }
  }

  const everyone: Implementers = new Map();
  for (const pairs of rounds.values()) for (const [k, v] of pairs) everyone.set(k, v);
  const reworkRounds = clampRound(record.round);
  for (const { resourceId, role } of everyone.values()) {
    const c = counters(buckets, resourceId, role);
    c.tasks += 1;
    c.reworkRounds += reworkRounds;
  }

  for (const review of record.reviews) {
    const approved = review.valid && review.verdict === 'approve';
    for (const { resourceId, role } of rounds.get(review.round)?.values() ?? []) {
      const c = counters(buckets, resourceId, role);
      c.reviewVerdicts += 1;
      c.reviewApprovals += approved ? 1 : 0;
    }
    if (review.resourceId !== '') {
      const c = counters(buckets, review.resourceId, 'review');
      c.producedVerdicts += 1;
      c.validVerdicts += review.valid ? 1 : 0;
    }
  }

  const outcome = record.approval?.outcome;
  if (outcome === 'approved' || outcome === 'denied') {
    for (const { resourceId, role } of rounds.get(record.round)?.values() ?? []) {
      const c = counters(buckets, resourceId, role);
      c.ownerDecisions += 1;
      c.ownerApprovals += outcome === 'approved' ? 1 : 0;
    }
  }
}

function toAggregate(c: Counters, role: LaneRole): LaneAggregate {
  const out: { -readonly [K in keyof LaneAggregate]: LaneAggregate[K] } = {
    samples: clampCount(c.samples),
  };
  if (c.latencies.length > 0) out.p50LatencyMs = median(c.latencies);
  if (role === 'architecture') return out;
  if (role === 'review') {
    if (c.producedVerdicts > 0) {
      out.producedVerdicts = clampCount(c.producedVerdicts);
      out.validVerdicts = clampCount(c.validVerdicts);
    }
    return out;
  }
  if (c.gateSamples > 0) {
    out.gateSamples = clampCount(c.gateSamples);
    out.firstRoundGatePasses = clampCount(c.firstRoundGatePasses);
  }
  if (c.tasks > 0) {
    out.tasks = clampCount(c.tasks);
    out.reworkRounds = clampCount(c.reworkRounds);
  }
  if (c.reviewVerdicts > 0) {
    out.reviewVerdicts = clampCount(c.reviewVerdicts);
    out.reviewApprovals = clampCount(c.reviewApprovals);
  }
  if (c.ownerDecisions > 0) {
    out.ownerDecisions = clampCount(c.ownerDecisions);
    out.ownerApprovals = clampCount(c.ownerApprovals);
  }
  return out;
}

/**
 * Pure aggregation of engineering records per (resource, lane role). Implementer and reviewer
 * quality stay separate; round outcomes are attributed to every implementer of that round.
 */
export function aggregateLaneHistory(
  records: readonly EngineeringRecord[],
): RoutingHistory['lanes'] {
  const buckets: Buckets = new Map();
  for (const record of records) addRecord(buckets, record);
  // Null-prototype maps: a resource id such as `__proto__` is an ordinary own key.
  const lanes = Object.create(null) as Record<string, Partial<Record<LaneRole, LaneAggregate>>>;
  for (const resourceId of [...buckets.keys()].sort()) {
    const roles = Object.create(null) as Partial<Record<LaneRole, LaneAggregate>>;
    const byRole = buckets.get(resourceId) as Map<LaneRole, Counters>;
    for (const role of [...byRole.keys()].sort()) {
      roles[role] = toAggregate(byRole.get(role) as Counters, role);
    }
    Object.defineProperty(lanes, resourceId, {
      value: roles,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return lanes;
}

// ---------------------------------------------------------------------------------------------
// Untrusted record guard
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

function obj(v: unknown): Json | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
}

function num(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function parseLane(v: unknown): LaneRecord | undefined {
  const o = obj(v);
  if (o === undefined) return undefined;
  const { role, round, resourceId, outcome, errorCode, latencyMs } = o;
  if (typeof role !== 'string' || !num(round) || !num(latencyMs)) return undefined;
  if (
    outcome !== 'succeeded' &&
    outcome !== 'failed' &&
    outcome !== 'cancelled' &&
    outcome !== 'timed-out'
  ) {
    return undefined;
  }
  if (resourceId !== undefined && typeof resourceId !== 'string') return undefined;
  if (errorCode !== undefined && typeof errorCode !== 'string') return undefined;
  return {
    laneId: '',
    role,
    round,
    taskId: '',
    ...(resourceId !== undefined ? { resourceId } : {}),
    reasonCodes: [],
    outcome,
    ...(errorCode !== undefined ? { errorCode } : {}),
    latencyMs,
  };
}

function parseCommand(v: unknown): CommandRecord | undefined {
  const o = obj(v);
  if (o === undefined) return undefined;
  if (typeof o['phase'] !== 'string' || !num(o['round']) || typeof o['passed'] !== 'boolean') {
    return undefined;
  }
  return {
    phase: o['phase'] as CommandRecord['phase'],
    round: o['round'],
    passed: o['passed'],
  } as CommandRecord;
}

function parseReview(v: unknown): ReviewRecord | undefined {
  const o = obj(v);
  if (o === undefined) return undefined;
  const { round, resourceId, verdict, valid } = o;
  if (!num(round) || typeof resourceId !== 'string' || typeof valid !== 'boolean') return undefined;
  if (verdict !== 'approve' && verdict !== 'request-changes') return undefined;
  return { round, resourceId, verdict, valid } as ReviewRecord;
}

function parseAll<T>(v: unknown, parse: (item: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: T[] = [];
  for (const item of v) {
    const parsed = parse(item);
    if (parsed === undefined) return undefined;
    out.push(parsed);
  }
  return out;
}

/** Keeps only the fields aggregation needs; `undefined` for anything malformed or foreign. */
function guardRecord(json: unknown): EngineeringRecord | undefined {
  const o = obj(json);
  if (o === undefined || o['schemaVersion'] !== 1) return undefined;
  if (typeof o['startedAt'] !== 'string' || typeof o['status'] !== 'string' || !num(o['round'])) {
    return undefined;
  }
  const lanes = parseAll(o['lanes'], parseLane);
  const commands = parseAll(o['commands'], parseCommand);
  const reviews = parseAll(o['reviews'], parseReview);
  if (lanes === undefined || commands === undefined || reviews === undefined) return undefined;
  let approval: EngineeringRecord['approval'];
  if (o['approval'] !== undefined) {
    const a = obj(o['approval']);
    if (a === undefined || typeof a['outcome'] !== 'string') return undefined;
    approval = { outcome: a['outcome'] };
  }
  return {
    schemaVersion: 1,
    taskId: '',
    projectId: '',
    planId: '',
    status: o['status'] as EngineeringRecord['status'],
    startedAt: o['startedAt'],
    baseBranch: '',
    branch: '',
    round: o['round'],
    lanes,
    commands,
    patches: [],
    reviews,
    ...(approval !== undefined ? { approval } : {}),
  };
}

/** Reads one record without following symlinks (task directory or file) and within `maxBytes`. */
async function readBounded(dir: string, maxBytes: number): Promise<unknown> {
  const dirInfo = await lstat(dir, { bigint: true });
  if (!dirInfo.isDirectory()) return undefined;
  const path = join(dir, RECORD_FILE);
  // Windows does not enforce O_NOFOLLOW; reject links before opening on every platform.
  const recordInfo = await lstat(path, { bigint: true });
  if (!recordInfo.isFile() || recordInfo.size > maxBytes) return undefined;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat({ bigint: true });
    if (
      !info.isFile() ||
      info.size > maxBytes ||
      info.dev !== recordInfo.dev ||
      info.ino !== recordInfo.ino
    )
      return undefined;
    // A record or task directory replaced between lstat and open must not supply history.
    const [currentRecord, currentDir] = await Promise.all([
      lstat(path, { bigint: true }),
      lstat(dir, { bigint: true }),
    ]);
    if (
      !currentRecord.isFile() ||
      !currentDir.isDirectory() ||
      currentRecord.dev !== info.dev ||
      currentRecord.ino !== info.ino ||
      currentDir.dev !== dirInfo.dev ||
      currentDir.ino !== dirInfo.ino
    )
      return undefined;
    return JSON.parse(await handle.readFile('utf8')) as unknown;
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------------------------

/**
 * Reads `<stateDir>/engineering/<task>/record.json` for every task started inside the window and
 * aggregates it. Malformed, oversized, symlinked or foreign records are counted in `skipped`;
 * records outside the window and in-flight (`running`) records are ignored. Never throws for bad
 * input; a missing directory yields an empty result.
 */
export async function readLaneHistory(
  stateDir: string,
  options: { readonly now: Date; readonly windowDays: number } & LaneHistoryOptions,
): Promise<LaneHistoryResult> {
  const maxRecords = Math.max(0, Math.trunc(options.maxRecords ?? DEFAULT_MAX_RECORDS));
  const maxBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
  const end = options.now.getTime();
  const start = end - options.windowDays * DAY_MS;

  let names: string[];
  try {
    names = await readdir(join(stateDir, 'engineering'));
  } catch {
    return { lanes: aggregateLaneHistory([]), skipped: 0 };
  }
  names = names.filter((name) => isTaskId(name)).sort();

  let skipped = Math.max(0, names.length - maxRecords);
  const records: EngineeringRecord[] = [];
  for (const name of names.slice(0, maxRecords)) {
    let record: EngineeringRecord | undefined;
    try {
      record = guardRecord(await readBounded(join(stateDir, 'engineering', name), maxBytes));
    } catch {
      record = undefined;
    }
    if (record === undefined) {
      skipped += 1;
      continue;
    }
    const startedAt = Date.parse(record.startedAt);
    if (!Number.isFinite(startedAt) || startedAt < start || startedAt > end) continue;
    if (record.status === 'running') continue;
    records.push(record);
  }
  return { lanes: aggregateLaneHistory(records), skipped };
}

/** A closure over the state directory for the telemetry history source. */
export function laneHistoryProvider(
  stateDir: string,
  windowDays: number,
  options: LaneHistoryOptions = {},
): (now: Date) => Promise<LaneHistoryResult> {
  return (now) => readLaneHistory(stateDir, { ...options, now, windowDays });
}
