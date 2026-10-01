import { chmod, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NexarError, type UsageReport } from '@nexar/contracts';

/**
 * Durable summary of an engineering task (ADR-019 section 10). Allowlisted fields only: ids,
 * lane roles, reason codes, resource ids, usage, exit codes, durations, counts and hashes. Never
 * the goal, prompts, diffs, gate output or any path; those live in task artifacts.
 */
export type EngineeringStatus = 'running' | 'committed' | 'not-accepted' | 'failed' | 'cancelled';

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

function isRecord(value: unknown): value is EngineeringRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    r['schemaVersion'] === 1 &&
    typeof r['taskId'] === 'string' &&
    typeof r['projectId'] === 'string' &&
    typeof r['status'] === 'string' &&
    Array.isArray(r['lanes'])
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
