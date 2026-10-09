import { chmod, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  NexarError,
  type ControlEngine,
  type EngineeringLineage,
  type UsageReport,
} from '@nexar/contracts';

/**
 * Durable summary of an engineering task (ADR-019 section 10). Allowlisted fields only: ids,
 * lane roles, reason codes, resource ids, usage, exit codes, durations, counts and hashes. Never
 * the goal, prompts, diffs, gate output or any path; those live in task artifacts.
 */
export type EngineeringStatus =
  'running' | 'committed' | 'reported' | 'not-accepted' | 'failed' | 'cancelled';

export interface LaneRecord {
  readonly laneId: string;
  readonly role: string;
  readonly round: number;
  /** The Nexar task id of the lane execution. */
  readonly taskId: string;
  /** Absent only when routing or execution failed before a resource was known. */
  readonly resourceId?: string;
  readonly reasonCodes: readonly string[];
  readonly outcome: 'succeeded' | 'failed' | 'cancelled' | 'timed-out';
  readonly errorCode?: string;
  readonly usage?: UsageReport;
  readonly latencyMs: number;
  /** SHA-256 of the lane's text artifact. */
  readonly outputSha256?: string;
  /** Resource the strategy planned for this lane; absent when the task ran unplanned. */
  readonly planned?: string;
  /** True when the lane ran on another resource than planned. */
  readonly fallback?: boolean;
  /**
   * Write lanes of a task with an engine gateway attempt (ADR-027 section 9): whether the lane ran
   * orchestrated by an engine or 
ative. Absent when no engine was configured.
   */
  readonly executor?: 'engine' | 'native';
  readonly engine?: ControlEngine;
  /** engine-unavailable, control-unavailable, engine-not-selected or control-resource-failed. */
  readonly executorReason?: string;
  readonly controlResourceId?: string;
  readonly controlDecisionId?: string;
}

/** Stamp of the upfront resource plan (`strategy@1`): ids, codes and counts only. */
export interface StrategyRecord {
  readonly policy: string;
  readonly configId?: string;
  readonly units: number;
  /** Reason code when the plan itself used the deterministic fallback. */
  readonly fallback?: string;
}

export interface CommandRecord {
  readonly phase: 'agent-setup' | 'verify-setup' | 'gate';
  readonly name: string;
  readonly round: number;
  /** `null` when the process was killed or could not start. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly outputSha256: string;
  readonly outputBytes: number;
}

export interface PatchRecord {
  readonly round: number;
  readonly sha256: string;
  readonly bytes: number;
  readonly files: number;
  readonly valid: boolean;
  /** Rule ids of violated patch policies; never paths. */
  readonly violations: readonly string[];
}

export interface ReviewRecord {
  readonly round: number;
  readonly resourceId: string;
  readonly verdict: 'approve' | 'request-changes';
  readonly valid: boolean;
  readonly findings: {
    readonly blocker: number;
    readonly major: number;
    readonly minor: number;
    readonly nit: number;
  };
  readonly reasonCodes: readonly string[];
  readonly outputSha256?: string;
}

export interface EngineeringRecord {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly projectId: string;
  readonly planId: string;
  readonly status: EngineeringStatus;
  readonly reason?: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly baseBranch: string;
  readonly baseCommit?: string;
  /** `nexar/<taskId>`; only exists as a branch once the task is committed. */
  readonly branch: string;
  /** Rework rounds used so far (0 = first attempt). */
  readonly round: number;
  readonly lanes: readonly LaneRecord[];
  readonly commands: readonly CommandRecord[];
  readonly patches: readonly PatchRecord[];
  readonly reviews: readonly ReviewRecord[];
  readonly approval?: { readonly id?: string; readonly outcome: string };
  readonly commit?: string;
  /** Report plans only: hash and size of the report; the text lives in the lane's artifact. */
  readonly report?: { readonly sha256: string; readonly bytes: number };
  /** Ids of the Operating turn that started the task (ADR-025); absent for CLI-started tasks. */
  readonly lineage?: EngineeringLineage;
  /** Present only when a strategist planned the lanes upfront. */
  readonly strategy?: StrategyRecord;
}

const SESSION_ID = /^ses_[0-9a-f]{32}$/;
const TURN_ID = /^turn_[0-9a-f]{32}$/;
const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LINEAGE_KEYS = ['sessionId', 'turnId', 'correlationId', 'depth'];

/** True for a well-formed lineage: exactly the four id fields, each matching its pattern. */
export function isEngineeringLineage(value: unknown): value is EngineeringLineage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const l = value as Record<string, unknown>;
  const keys = Object.keys(l);
  return (
    keys.length === LINEAGE_KEYS.length &&
    LINEAGE_KEYS.every((key) => keys.includes(key)) &&
    typeof l['sessionId'] === 'string' &&
    SESSION_ID.test(l['sessionId']) &&
    typeof l['turnId'] === 'string' &&
    TURN_ID.test(l['turnId']) &&
    typeof l['correlationId'] === 'string' &&
    CORRELATION_ID.test(l['correlationId']) &&
    typeof l['depth'] === 'number' &&
    Number.isInteger(l['depth']) &&
    l['depth'] >= 0 &&
    l['depth'] <= 2
  );
}

export const RECORD_FILE = 'record.json';
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** True for a well-formed engineering task id (also the directory name under `engineering/`). */
export function isTaskId(id: string): boolean {
  return TASK_ID.test(id);
}

function assertTaskId(id: string): void {
  if (!TASK_ID.test(id)) throw new NexarError('VALIDATION_ERROR', 'Invalid engineering task id');
}

/** `<stateDir>/engineering/<taskId>/record.json` */
export function recordPathFor(stateDir: string, taskId: string): string {
  assertTaskId(taskId);
  return join(stateDir, 'engineering', taskId, RECORD_FILE);
}

/** Writes the record atomically (dir 0700, file 0600). Returns the record path. */
export async function writeEngineeringRecord(
  stateDir: string,
  record: EngineeringRecord,
): Promise<string> {
  const path = recordPathFor(stateDir, record.taskId);
  const dir = join(stateDir, 'engineering', record.taskId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  return path;
}

const CODE_TEXT = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const STRATEGY_KEYS = new Set(['policy', 'configId', 'units', 'fallback']);
const MAX_STRATEGY_UNITS = 64;

const isCodeText = (value: unknown): value is string =>
  typeof value === 'string' && CODE_TEXT.test(value);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** True for a well-formed strategy stamp: known keys only, bounded id-like strings and a count. */
export function isStrategyRecord(value: unknown): value is StrategyRecord {
  if (!isPlainObject(value)) return false;
  return (
    Object.keys(value).every((key) => STRATEGY_KEYS.has(key)) &&
    isCodeText(value['policy']) &&
    (value['configId'] === undefined || isCodeText(value['configId'])) &&
    (value['fallback'] === undefined || isCodeText(value['fallback'])) &&
    typeof value['units'] === 'number' &&
    Number.isInteger(value['units']) &&
    value['units'] >= 0 &&
    value['units'] <= MAX_STRATEGY_UNITS
  );
}

/** Lanes from older records carry neither field; when present they must be well-formed. */
function isLaneShape(lane: unknown): boolean {
  if (!isPlainObject(lane)) return false;
  return (
    (lane['planned'] === undefined || isCodeText(lane['planned'])) &&
    (lane['fallback'] === undefined || typeof lane['fallback'] === 'boolean')
  );
}

function isRecord(value: unknown): value is EngineeringRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    r['schemaVersion'] === 1 &&
    typeof r['taskId'] === 'string' &&
    typeof r['projectId'] === 'string' &&
    typeof r['status'] === 'string' &&
    Array.isArray(r['lanes']) &&
    r['lanes'].every(isLaneShape) &&
    (r['lineage'] === undefined || isEngineeringLineage(r['lineage'])) &&
    (r['strategy'] === undefined || isStrategyRecord(r['strategy']))
  );
}

/** Reads one record; `undefined` when it does not exist. Throws for a corrupt or foreign file. */
export async function readEngineeringRecord(
  stateDir: string,
  taskId: string,
): Promise<EngineeringRecord | undefined> {
  let text: string;
  try {
    text = await readFile(recordPathFor(stateDir, taskId), 'utf8');
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return undefined;
    throw new NexarError('INTERNAL_ERROR', 'Engineering record could not be read');
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new NexarError('INTERNAL_ERROR', 'Engineering record is not valid JSON');
  }
  if (!isRecord(json) || json.taskId !== taskId) {
    throw new NexarError('INTERNAL_ERROR', 'Engineering record has an unexpected shape');
  }
  return json;
}

/** All readable records, oldest first. Unreadable entries are skipped. */
export async function listEngineeringRecords(stateDir: string): Promise<EngineeringRecord[]> {
  let names: string[];
  try {
    names = await readdir(join(stateDir, 'engineering'));
  } catch {
    return [];
  }
  const records: EngineeringRecord[] = [];
  for (const name of names) {
    if (!TASK_ID.test(name)) continue;
    try {
      const record = await readEngineeringRecord(stateDir, name);
      if (record !== undefined) records.push(record);
    } catch {
      // Skip a corrupt record; listing must not fail because of one bad file.
    }
  }
  return records.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
