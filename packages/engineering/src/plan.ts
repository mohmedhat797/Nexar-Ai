import { readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { NexarError, isNexarError } from '@nexar/contracts';
import { resolveContainedPath } from '@nexar/projects';
import {
  LaneTemplateError,
  assertSystemTemplate,
  parseLaneTemplate,
  type LaneTemplate,
} from './render.js';

export type PlanLaneRole = 'architecture' | 'feature' | 'tests' | 'review';

/** One lane of a plan, with its templates loaded. The system prompt is trusted and has no variables. */
export interface PlanLane {
  readonly id: string;
  readonly role: PlanLaneRole;
  readonly access: 'read-only' | 'read-write';
  readonly taskKind: string;
  readonly capabilities: readonly string[];
  readonly system: string;
  readonly brief: LaneTemplate;
}

export interface LoadedPlan {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly lanes: readonly PlanLane[];
  /** The built-in rework lane, shared by every plan. */
  readonly debugging: { readonly system: string; readonly brief: LaneTemplate };
}

export const PLAN_FILE = 'plan.json';
export const SHARED_DIRECTORY = '_shared';
const MAX_TEMPLATE_BYTES = 256 * 1024;
const PLAN_ID = /^[a-z][a-z0-9-]{0,63}$/;
const LANE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const TEMPLATE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.md$/;
const ROLES = ['architecture', 'feature', 'tests', 'review', 'debugging'] as const;
const ACCESS_BY_ROLE: Readonly<Record<PlanLaneRole, PlanLane['access']>> = {
  architecture: 'read-only',
  feature: 'read-write',
  tests: 'read-write',
  review: 'read-only',
};

function configError(message: string): NexarError {
  return new NexarError('CONFIGURATION_ERROR', message);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  what: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw configError(`${what}: unknown key "${key}"`);
  }
}

function text(value: unknown, what: string, max = 2000): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw configError(`${what} must be a non-empty string of at most ${String(max)} characters`);
  }
  return value;
}

async function readTemplate(realDir: string, file: unknown, what: string): Promise<string> {
  if (typeof file !== 'string' || !TEMPLATE_FILE.test(file)) {
    throw configError(`${what} must be a plain Markdown file name`);
  }
  let real: string;
  try {
    real = await resolveContainedPath(join(realDir, file), [realDir]);
  } catch (error) {
    if (!isNexarError(error)) throw error;
    throw configError(`${what} does not exist or is outside the plan directory`);
  }
  const content = await readFile(real, 'utf8');
  if (Buffer.byteLength(content) > MAX_TEMPLATE_BYTES) throw configError(`${what} is too large`);
  return content;
}

async function loadTemplates(
  realDir: string,
  system: unknown,
  brief: unknown,
  label: string,
): Promise<{ system: string; brief: LaneTemplate }> {
  const systemText = await readTemplate(realDir, system, `${label} system template`);
  const briefText = await readTemplate(realDir, brief, `${label} brief template`);
  try {
    assertSystemTemplate(systemText, `${label} system template`);
    return { system: systemText, brief: parseLaneTemplate(briefText, `${label} brief template`) };
  } catch (error) {
    if (error instanceof LaneTemplateError) throw configError(error.message);
    throw error;
  }
}

/** Order rule: optional architecture first, then read-write lanes, then exactly one review last. */
function laneOrderProblem(lanes: readonly PlanLane[]): string | undefined {
  const reviews = lanes.filter((l) => l.role === 'review');
  if (reviews.length !== 1) return 'a plan needs exactly one review lane';
  if (lanes[lanes.length - 1]?.role !== 'review') return 'the review lane must be last';
  const architecture = lanes.filter((l) => l.role === 'architecture');
  if (architecture.length > 1) return 'a plan may have at most one architecture lane';
  if (architecture.length === 1 && lanes[0]?.role !== 'architecture') {
    return 'the architecture lane must be first';
  }
  const middle = lanes.filter((l) => l.role !== 'architecture' && l.role !== 'review');
  if (middle.length === 0) return 'a plan needs at least one read-write lane (feature or tests)';
  return undefined;
}

async function loadLane(
  realDir: string,
  raw: unknown,
  index: number,
  planId: string,
): Promise<PlanLane> {
  const what = `Plan "${planId}" lane ${String(index + 1)}`;
  if (!isRecord(raw)) throw configError(`${what} must be an object`);
  assertKeys(raw, ['id', 'role', 'access', 'taskKind', 'capabilities', 'system', 'brief'], what);
  const id = text(raw['id'], `${what} id`, 32);
  if (!LANE_ID.test(id)) throw configError(`${what}: invalid lane id`);
  const role = raw['role'];
  if (role === 'debugging') {
    throw configError(`${what}: "debugging" is the built-in rework lane and cannot be listed`);
  }
  if (typeof role !== 'string' || !(ROLES as readonly string[]).includes(role)) {
    throw configError(`${what}: role must be one of architecture, feature, tests, review`);
  }
  const laneRole = role as PlanLaneRole;
  const access = raw['access'];
  if (access !== 'read-only' && access !== 'read-write') {
    throw configError(`${what}: access must be "read-only" or "read-write"`);
  }
  if (access !== ACCESS_BY_ROLE[laneRole]) {
    throw configError(`${what}: a ${laneRole} lane must be ${ACCESS_BY_ROLE[laneRole]}`);
  }
  const capabilities = raw['capabilities'];
  if (
    !Array.isArray(capabilities) ||
    capabilities.length === 0 ||
    !capabilities.every((c) => typeof c === 'string' && c !== '')
  ) {
    throw configError(`${what}: capabilities must be a non-empty list of strings`);
  }
  const templates = await loadTemplates(realDir, raw['system'], raw['brief'], what);
  return {
    id,
    role: laneRole,
    access,
    taskKind: text(raw['taskKind'], `${what} taskKind`, 64),
    capabilities: capabilities as string[],
    ...templates,
  };
}

async function loadPlan(
  realDir: string,
  expectedId: string,
  debugging: LoadedPlan['debugging'],
): Promise<LoadedPlan> {
  const label = `Plan "${expectedId}"`;
  let json: unknown;
  try {
    json = JSON.parse(await readPlanFile(realDir));
  } catch (error) {
    if (isNexarError(error)) throw error;
    throw configError(`${label}: ${PLAN_FILE} is not valid JSON`);
  }
  if (!isRecord(json)) throw configError(`${label}: ${PLAN_FILE} must be an object`);
  assertKeys(json, ['schemaVersion', 'id', 'displayName', 'description', 'lanes'], label);
  if (json['schemaVersion'] !== 1) throw configError(`${label}: schemaVersion must be 1`);
  const id = json['id'];
  if (typeof id !== 'string' || !PLAN_ID.test(id)) throw configError(`${label}: invalid id`);
  if (id !== expectedId) throw configError(`${label}: id "${id}" must equal its directory name`);
  const lanesRaw = json['lanes'];
  if (!Array.isArray(lanesRaw) || lanesRaw.length === 0) {
    throw configError(`${label}: lanes must be a non-empty list`);
  }
  const lanes: PlanLane[] = [];
  for (const [index, raw] of (lanesRaw as unknown[]).entries()) {
    const lane = await loadLane(realDir, raw, index, id);
    if (lanes.some((l) => l.id === lane.id)) throw configError(`${label}: duplicate lane id`);
    lanes.push(lane);
  }
  const problem = laneOrderProblem(lanes);
  if (problem !== undefined) throw configError(`${label}: ${problem}`);
  return {
    id,
    displayName: text(json['displayName'], `${label} displayName`, 200),
    description: text(json['description'], `${label} description`, 2000),
    lanes,
    debugging,
  };
}

async function readPlanFile(realDir: string): Promise<string> {
  const real = await resolveContainedPath(join(realDir, PLAN_FILE), [realDir]).catch(() => {
    throw configError(`${PLAN_FILE} does not exist or is outside the plan directory`);
  });
  const content = await readFile(real, 'utf8');
  if (Buffer.byteLength(content) > MAX_TEMPLATE_BYTES)
    throw configError(`${PLAN_FILE} is too large`);
  return content;
}

/** Engineering lane plans loaded from `engineering/plans/` (data, like workflows). */
export class PlanCatalog {
  private constructor(private readonly plans: ReadonlyMap<string, LoadedPlan>) {}

  /** Loads every plan directory (names starting with `_` or `.` are skipped). Fails on any invalid plan. */
  static async load(directory: string): Promise<PlanCatalog> {
    let root: string;
    try {
      root = await realpath(directory);
    } catch {
      throw configError('Engineering plans directory does not exist');
    }
    const shared = join(root, SHARED_DIRECTORY);
    let sharedReal: string;
    try {
      sharedReal = await resolveContainedPath(shared, [root]);
    } catch {
      throw configError(`Engineering plans directory has no ${SHARED_DIRECTORY} directory`);
    }
    const debugging = await loadTemplates(
      sharedReal,
      'debugging.system.md',
      'debugging.md',
      'Shared debugging lane',
    );
    const plans = new Map<string, LoadedPlan>();
    const entries = (await readdir(root, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const real = await resolveContainedPath(join(root, entry.name), [root]).catch(() => {
        throw configError(`Plan "${entry.name}" is outside the plans directory`);
      });
      plans.set(entry.name, await loadPlan(real, entry.name, debugging));
    }
    return new PlanCatalog(plans);
  }

  get(id: string): LoadedPlan | undefined {
    return this.plans.get(id);
  }

  /** Unknown ids are `VALIDATION_ERROR`. */
  require(id: string): LoadedPlan {
    const plan = this.plans.get(id);
    if (plan === undefined) throw new NexarError('VALIDATION_ERROR', `Unknown plan "${id}"`);
    return plan;
  }

  list(): readonly LoadedPlan[] {
    return [...this.plans.values()];
  }
}
