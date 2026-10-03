import { NexarError } from '@nexar/contracts';
import type { ArtifactRef } from '@nexar/contracts';
import {
  APPROVAL_ID_PATTERN,
  assertProjectId,
  assertSessionId,
  assertSubmissionKey,
  assertTurnId,
} from './ids.js';
import {
  MAX_APPROVALS_PER_TURN,
  MAX_ARTIFACTS_PER_TURN,
  MAX_ENGINEERING_LANES,
  MAX_ERROR_MESSAGE_CHARS,
  MAX_OUTCOME_CHARS,
  MAX_TASKS_PER_TURN,
  MAX_TEXT_CHARS,
  MAX_TITLE_CHARS,
  MAX_TURNS,
} from './limits.js';
import { TERMINAL_TURN_STATES } from './types.js';
import type {
  ContextManifest,
  LaneDecision,
  OperatingLane,
  OperatingMode,
  OperatingSession,
  Turn,
  TurnEngineering,
  TurnIntent,
  TurnOutcome,
  TurnState,
  TurnTaskLink,
} from './types.js';

/*
 * Pure state transitions for an OperatingSession (ADR-024 §2, §7, §8, §11). No IO, no clock, no
 * ids: callers inject `now` and ids. Every change returns a new value with `revision + 1` and
 * `updatedAt = now`. Error details carry constant reasons and ids the caller already supplied,
 * never turn text or outcome content.
 */

/** Result of a transition that targets one turn. */
export interface TurnMutation {
  readonly session: OperatingSession;
  readonly turn: Turn;
}

export interface BeginTurnResult extends TurnMutation {
  /** False when the submission key already existed and nothing changed (idempotent replay). */
  readonly created: boolean;
}

function conflict(reason: string, extra: Readonly<Record<string, unknown>> = {}): NexarError {
  return new NexarError('CONFLICT', `Session conflict: ${reason}`, {
    details: { reason, ...extra },
  });
}

function invalid(reason: string): NexarError {
  return new NexarError('VALIDATION_ERROR', `Invalid session operation: ${reason}`, {
    details: { reason },
  });
}

function isTerminal(state: TurnState): boolean {
  return TERMINAL_TURN_STATES.includes(state);
}

function normalizeTitle(title: unknown): string {
  if (typeof title !== 'string') throw invalid('title');
  const trimmed = title.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TITLE_CHARS) throw invalid('title');
  return trimmed;
}

function assertMode(mode: unknown): asserts mode is OperatingMode {
  if (mode !== 'cowork' && mode !== 'code') throw invalid('mode');
}

function bump(
  session: OperatingSession,
  now: string,
  patch: Partial<OperatingSession>,
): OperatingSession {
  return { ...session, ...patch, revision: session.revision + 1, updatedAt: now };
}

function locate(session: OperatingSession, turnId: string): { turn: Turn; index: number } {
  assertTurnId(turnId);
  const index = session.turns.findIndex((t) => t.id === turnId);
  const turn = session.turns[index];
  if (turn === undefined) throw invalid('unknown-turn');
  return { turn, index };
}

function requireOpen(turn: Turn): void {
  if (isTerminal(turn.state)) throw conflict('turn-finished');
}

function replaceTurn(
  session: OperatingSession,
  index: number,
  turn: Turn,
  now: string,
  patch: Partial<OperatingSession> = {},
): TurnMutation {
  const next: Turn = { ...turn, updatedAt: now };
  const turns = session.turns.map((t, i) => (i === index ? next : t));
  return { session: bump(session, now, { ...patch, turns }), turn: next };
}

function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let end = max;
  const last = text.charCodeAt(end - 1);
  // Do not split a surrogate pair.
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

export interface CreateSessionInput {
  readonly id: string;
  readonly projectId: string;
  readonly mode: OperatingMode;
  readonly title: string;
  readonly now: string;
}

export function createSession(input: CreateSessionInput): OperatingSession {
  assertSessionId(input.id);
  assertProjectId(input.projectId);
  assertMode(input.mode);
  return {
    schemaVersion: 1,
    id: input.id,
    projectId: input.projectId,
    mode: input.mode,
    title: normalizeTitle(input.title),
    createdAt: input.now,
    updatedAt: input.now,
    revision: 1,
    activeTurnId: null,
    turns: [],
  };
}

export interface BeginTurnInput {
  readonly turnId: string;
  readonly submissionKey: string;
  readonly text: string;
  readonly now: string;
  /** Defaults to `running`. `pending-confirmation` requires a `lane` (the mismatch to confirm). */
  readonly state?: 'running' | 'pending-confirmation';
  readonly intent?: TurnIntent;
  readonly lane?: LaneDecision;
}

export function beginTurn(session: OperatingSession, input: BeginTurnInput): BeginTurnResult {
  assertTurnId(input.turnId);
  assertSubmissionKey(input.submissionKey);
  if (
    typeof input.text !== 'string' ||
    input.text.trim().length === 0 ||
    input.text.length > MAX_TEXT_CHARS
  ) {
    throw invalid('text');
  }
  const state = input.state ?? 'running';
  if (state !== 'running' && state !== 'pending-confirmation') throw invalid('state');
  if (state === 'pending-confirmation' && input.lane === undefined) throw invalid('lane-required');

  const existing = session.turns.find((t) => t.submissionKey === input.submissionKey);
  if (existing !== undefined) {
    if (existing.text !== input.text) throw invalid('submission-key-reused');
    return { session, turn: existing, created: false };
  }
  if (session.activeTurnId !== null) {
    throw conflict('session-busy', { activeTurnId: session.activeTurnId });
  }
  if (session.turns.length >= MAX_TURNS) {
    throw new NexarError('POLICY_REJECTED', 'Session is full', {
      details: { reason: 'session-full' },
    });
  }
  if (session.turns.some((t) => t.id === input.turnId)) throw conflict('duplicate-turn-id');

  const turn: Turn = {
    id: input.turnId,
    index: session.turns.length,
    submissionKey: input.submissionKey,
    createdAt: input.now,
    updatedAt: input.now,
    text: input.text,
    state,
    ...(input.intent === undefined ? {} : { intent: input.intent }),
    ...(input.lane === undefined ? {} : { lane: input.lane }),
    tasks: [],
    artifacts: [],
    approvalIds: [],
  };
  return {
    session: bump(session, input.now, {
      turns: [...session.turns, turn],
      activeTurnId: turn.id,
    }),
    turn,
    created: true,
  };
}

export type ConfirmationDecision =
  | {
      readonly decision: 'confirm';
      readonly effectiveLane?: OperatingLane;
      /** The re-evaluated fallback reason; `null` clears a stale one, absent keeps it. */
      readonly fallbackReason?: string | null;
    }
  | { readonly decision: 'decline' };

export function resolveConfirmation(
  session: OperatingSession,
  turnId: string,
  resolution: ConfirmationDecision,
  now: string,
): TurnMutation {
  const { turn, index } = locate(session, turnId);
  requireOpen(turn);
  if (turn.state !== 'pending-confirmation') throw conflict('not-pending-confirmation');
  if (resolution.decision === 'decline') {
    return replaceTurn(session, index, { ...turn, state: 'declined' }, now, {
      activeTurnId: null,
    });
  }
  if (resolution.decision !== 'confirm' || turn.lane === undefined) throw invalid('confirmation');
  const fallbackReason =
    resolution.fallbackReason === undefined ? turn.lane.fallbackReason : resolution.fallbackReason;
  const lane: LaneDecision = {
    policy: turn.lane.policy,
    mode: turn.lane.mode,
    requestedLane: turn.lane.requestedLane,
    effectiveLane: resolution.effectiveLane ?? turn.lane.effectiveLane,
    ...(turn.lane.mismatch === undefined ? {} : { mismatch: turn.lane.mismatch }),
    confirmed: true,
    ...(fallbackReason === null || fallbackReason === undefined ? {} : { fallbackReason }),
  };
  return replaceTurn(session, index, { ...turn, state: 'running', lane }, now);
}

export function linkTask(
  session: OperatingSession,
  turnId: string,
  task: TurnTaskLink,
  now: string,
): TurnMutation {
  const { turn, index } = locate(session, turnId);
  requireOpen(turn);
  if (typeof task.taskId !== 'string' || task.taskId.length === 0 || task.taskId.length > 128) {
    throw invalid('task-id');
  }
  if (turn.tasks.some((t) => t.taskId === task.taskId)) throw invalid('duplicate-task');
  if (turn.tasks.length >= MAX_TASKS_PER_TURN) {
    throw new NexarError('POLICY_REJECTED', 'Too many tasks for this turn', {
      details: { reason: 'too-many-tasks' },
    });
  }
  return replaceTurn(session, index, { ...turn, tasks: [...turn.tasks, task] }, now);
}

export type TaskUpdate = Partial<Omit<TurnTaskLink, 'taskId'>>;

export function updateTask(
  session: OperatingSession,
  turnId: string,
  taskId: string,
  patch: TaskUpdate,
  now: string,
): TurnMutation {
  const { turn, index } = locate(session, turnId);
  requireOpen(turn);
  if (!turn.tasks.some((t) => t.taskId === taskId)) throw invalid('unknown-task');
  const tasks = turn.tasks.map((t) => (t.taskId === taskId ? { ...t, ...patch, taskId } : t));
  return replaceTurn(session, index, { ...turn, tasks }, now);
}

export function linkArtifacts(
  session: OperatingSession,
  turnId: string,
  artifacts: readonly ArtifactRef[],
  now: string,
): TurnMutation {
  const { turn, index } = locate(session, turnId);
  requireOpen(turn);
  const merged = [...turn.artifacts];
  for (const artifact of artifacts) {
    if (!merged.some((a) => a.uri === artifact.uri)) merged.push(artifact);
  }
  if (merged.length > MAX_ARTIFACTS_PER_TURN) {
    throw new NexarError('POLICY_REJECTED', 'Too many artifacts for this turn', {
      details: { reason: 'too-many-artifacts' },
    });
  }
  return replaceTurn(session, index, { ...turn, artifacts: merged }, now);
}

export function linkApprovals(
  session: OperatingSession,
  turnId: string,
  approvalIds: readonly string[],
  now: string,
): TurnMutation {
  const { turn, index } = locate(session, turnId);
  requireOpen(turn);
  const merged = [...turn.approvalIds];
  for (const id of approvalIds) {
    if (typeof id !== 'string' || !APPROVAL_ID_PATTERN.test(id)) throw invalid('approval-id');
    if (!merged.includes(id)) merged.push(id);
  }
  if (merged.length > MAX_APPROVALS_PER_TURN) {
    throw new NexarError('POLICY_REJECTED', 'Too many approvals for this turn', {
      details: { reason: 'too-many-approvals' },
    });
  }
  return replaceTurn(session, index, { ...turn, approvalIds: merged }, now);
}

export function setContext(
  session: OperatingSession,
  turnId: string,
  context: ContextManifest,
  now: string,
): TurnMutation {
  const { turn, index } = locate(session, turnId);
  requireOpen(turn);
  return replaceTurn(session, index, { ...turn, context }, now);
}

export interface CompleteTurnInput {
  readonly state: 'succeeded' | 'failed' | 'cancelled';
  readonly outcome?: TurnOutcome;
}

const PLANE_TASK_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const COMMIT_ID = /^[0-9a-f]{40,64}$/;
const ENGINEERING_STATUSES: readonly string[] = [
  'committed',
  'reported',
  'not-accepted',
  'failed',
  'cancelled',
];

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Copies only the known, bounded scalar fields; anything else is dropped or rejected. */
function boundEngineering(value: TurnEngineering): TurnEngineering {
  if (
    typeof value.planeTaskId !== 'string' ||
    !PLANE_TASK_ID.test(value.planeTaskId) ||
    !ENGINEERING_STATUSES.includes(value.status)
  ) {
    throw invalid('engineering');
  }
  const out: { -readonly [K in keyof TurnEngineering]: TurnEngineering[K] } = {
    planeTaskId: value.planeTaskId,
    status: value.status,
  };
  if (value.lanes !== undefined) {
    if (!Array.isArray(value.lanes) || value.lanes.length > MAX_ENGINEERING_LANES) {
      throw invalid('engineering');
    }
    out.lanes = value.lanes.map((lane: { role?: unknown; resourceId?: unknown }) => {
      const { role, resourceId } = lane;
      if (
        typeof role !== 'string' ||
        role.length < 1 ||
        role.length > 64 ||
        typeof resourceId !== 'string' ||
        resourceId.length < 1 ||
        resourceId.length > 128
      ) {
        throw invalid('engineering');
      }
      return { role, resourceId };
    });
  }
  if (value.branch !== undefined) {
    if (typeof value.branch !== 'string' || value.branch.length < 1 || value.branch.length > 200) {
      throw invalid('engineering');
    }
    out.branch = value.branch;
  }
  if (value.commit !== undefined) {
    if (typeof value.commit !== 'string' || !COMMIT_ID.test(value.commit)) {
      throw invalid('engineering');
    }
    out.commit = value.commit;
  }
  for (const field of ['files', 'gatesPassed'] as const) {
    const count = value[field];
    if (count === undefined) continue;
    if (!isCount(count)) throw invalid('engineering');
    out[field] = count;
  }
  if (value.reviewVerdict !== undefined) {
    const verdict = value.reviewVerdict;
    if (typeof verdict !== 'string' || verdict.length < 1 || verdict.length > 32) {
      throw invalid('engineering');
    }
    out.reviewVerdict = verdict;
  }
  if (value.approvalId !== undefined) {
    if (typeof value.approvalId !== 'string' || !APPROVAL_ID_PATTERN.test(value.approvalId)) {
      throw invalid('engineering');
    }
    out.approvalId = value.approvalId;
  }
  return out;
}

function boundOutcome(outcome: TurnOutcome | undefined): TurnOutcome | undefined {
  if (outcome === undefined) return undefined;
  const bounded: { -readonly [K in keyof TurnOutcome]: TurnOutcome[K] } = {};
  if (outcome.text !== undefined) {
    const { text, truncated } = truncateText(outcome.text, MAX_OUTCOME_CHARS);
    bounded.text = text;
    if (truncated || outcome.textTruncated === true) bounded.textTruncated = true;
  } else if (outcome.textTruncated !== undefined) {
    bounded.textTruncated = outcome.textTruncated;
  }
  if (outcome.error !== undefined) {
    bounded.error = {
      code: truncateText(outcome.error.code, 64).text,
      message: truncateText(outcome.error.message, MAX_ERROR_MESSAGE_CHARS).text,
    };
  }
  if (outcome.engineering !== undefined)
    bounded.engineering = boundEngineering(outcome.engineering);
  return bounded;
}

export function completeTurn(
  session: OperatingSession,
  turnId: string,
  input: CompleteTurnInput,
  now: string,
): TurnMutation {
  const { turn, index } = locate(session, turnId);
  requireOpen(turn);
  if (input.state !== 'succeeded' && input.state !== 'failed' && input.state !== 'cancelled') {
    throw invalid('state');
  }
  if (turn.state !== 'running') throw conflict('turn-not-running');
  const outcome = boundOutcome(input.outcome);
  const next: Turn = {
    ...turn,
    state: input.state,
    ...(outcome === undefined ? {} : { outcome }),
  };
  return replaceTurn(session, index, next, now, {
    activeTurnId: session.activeTurnId === turn.id ? null : session.activeTurnId,
  });
}

export interface InterruptResult {
  readonly session: OperatingSession;
  readonly interrupted: number;
}

/**
 * Restart recovery (ADR-024 §11): every `running` turn becomes `interrupted`; nothing is replayed.
 * `pending-confirmation` turns stay pending. Returns the same session when nothing changed.
 */
export function interruptRunning(session: OperatingSession, now: string): InterruptResult {
  let interrupted = 0;
  const turns = session.turns.map((t) => {
    if (t.state !== 'running') return t;
    interrupted += 1;
    // Its tasks were cut off too; none of them is resumed or replayed.
    const tasks = t.tasks.map((task) =>
      task.state === 'running' ? { ...task, state: 'interrupted' as const } : task,
    );
    return { ...t, state: 'interrupted' as const, tasks, updatedAt: now };
  });
  if (interrupted === 0) return { session, interrupted };
  const active = turns.find((t) => t.id === session.activeTurnId);
  const activeTurnId =
    active !== undefined && active.state === 'interrupted' ? null : session.activeTurnId;
  return { session: bump(session, now, { turns, activeTurnId }), interrupted };
}

/** Takes effect on the next turn; a running turn keeps the lane it started with. */
export function setMode(
  session: OperatingSession,
  mode: OperatingMode,
  now: string,
): OperatingSession {
  assertMode(mode);
  if (mode === session.mode) return session;
  return bump(session, now, { mode, modeChangedAt: now });
}

export function rename(session: OperatingSession, title: string, now: string): OperatingSession {
  return bump(session, now, { title: normalizeTitle(title) });
}
