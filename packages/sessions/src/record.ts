import { NexarError } from '@nexar/contracts';
import { z } from 'zod';
import {
  APPROVAL_ID_PATTERN,
  PROJECT_ID_PATTERN,
  SESSION_ID_PATTERN,
  SUBMISSION_KEY_PATTERN,
  TURN_ID_PATTERN,
} from './ids.js';
import {
  MAX_APPROVALS_PER_TURN,
  MAX_ARTIFACTS_PER_TURN,
  MAX_ERROR_MESSAGE_CHARS,
  MAX_OUTCOME_CHARS,
  MAX_TASKS_PER_TURN,
  MAX_TEXT_CHARS,
  MAX_TITLE_CHARS,
  MAX_TURNS,
} from './limits.js';
import type { OperatingSession } from './types.js';

/*
 * Strict, prototype-safe record parsing. Anything unexpected fails closed with a generic error:
 * file paths and record content never appear in messages or details.
 */

function corrupt(): NexarError {
  return new NexarError('VALIDATION_ERROR', 'Session record is unreadable', {
    details: { reason: 'corrupt-record' },
  });
}

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Rejects prototype-polluting keys anywhere in parsed JSON, before schema validation. */
function hasForbiddenKey(value: unknown, depth = 0): boolean {
  if (depth > 32) return true;
  if (Array.isArray(value)) return value.some((v) => hasForbiddenKey(v, depth + 1));
  if (typeof value !== 'object' || value === null) return false;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) return true;
    if (hasForbiddenKey((value as Record<string, unknown>)[key], depth + 1)) return true;
  }
  return false;
}

const iso = z.iso.datetime();
const id = (pattern: RegExp): z.ZodString => z.string().regex(pattern);
const label = (max: number): z.ZodString => z.string().min(1).max(max);
const stringList = (max: number, itemMax: number): z.ZodArray<z.ZodString> =>
  z.array(label(itemMax)).max(max);

const modeSchema = z.enum(['cowork', 'code']);
const laneSchema = z.enum(['cowork', 'code', 'direct']);

const turnStateSchema = z.enum([
  'pending-confirmation',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
  'declined',
]);

const intentSchema = z.strictObject({
  kind: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/),
  source: z.enum(['explicit', 'rules']),
  ruleIds: stringList(32, 64),
  policy: label(64),
});

const laneDecisionSchema = z.strictObject({
  policy: label(64),
  mode: modeSchema,
  requestedLane: laneSchema,
  effectiveLane: laneSchema,
  mismatch: z.strictObject({ from: laneSchema, to: laneSchema }).optional(),
  confirmed: z.boolean().optional(),
  fallbackReason: z.string().max(200).optional(),
});

const taskSchema = z.strictObject({
  taskId: label(128),
  state: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  resourceId: label(128).optional(),
  policyId: label(128).optional(),
  fallback: z.boolean().optional(),
});

const artifactSchema = z.strictObject({
  uri: label(2048),
  mediaType: label(128).optional(),
  label: z.string().max(256).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  draft: z.boolean().optional(),
});

const contextSchema = z.strictObject({
  policy: label(64),
  turnIds: z.array(id(TURN_ID_PATTERN)).max(MAX_TURNS),
  omittedTurns: z.number().int().nonnegative(),
  truncatedTurnIds: z.array(id(TURN_ID_PATTERN)).max(MAX_TURNS),
  chars: z.number().int().nonnegative(),
  artifactIds: stringList(MAX_ARTIFACTS_PER_TURN * 8, 2048),
  hash: label(128),
});

const outcomeSchema = z.strictObject({
  text: z.string().max(MAX_OUTCOME_CHARS).optional(),
  textTruncated: z.boolean().optional(),
  error: z
    .strictObject({ code: label(64), message: z.string().max(MAX_ERROR_MESSAGE_CHARS) })
    .optional(),
});

const turnSchema = z.strictObject({
  id: id(TURN_ID_PATTERN),
  index: z.number().int().nonnegative(),
  submissionKey: id(SUBMISSION_KEY_PATTERN),
  createdAt: iso,
  updatedAt: iso,
  text: z.string().min(1).max(MAX_TEXT_CHARS),
  state: turnStateSchema,
  intent: intentSchema.optional(),
  lane: laneDecisionSchema.optional(),
  tasks: z.array(taskSchema).max(MAX_TASKS_PER_TURN),
  artifacts: z.array(artifactSchema).max(MAX_ARTIFACTS_PER_TURN),
  approvalIds: z.array(id(APPROVAL_ID_PATTERN)).max(MAX_APPROVALS_PER_TURN),
  context: contextSchema.optional(),
  outcome: outcomeSchema.optional(),
});

const sessionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: id(SESSION_ID_PATTERN),
  projectId: id(PROJECT_ID_PATTERN),
  mode: modeSchema,
  title: z.string().min(1).max(MAX_TITLE_CHARS),
  createdAt: iso,
  updatedAt: iso,
  revision: z.number().int().positive(),
  activeTurnId: id(TURN_ID_PATTERN).nullable(),
  modeChangedAt: iso.optional(),
  turns: z.array(turnSchema).max(MAX_TURNS),
});

const OPEN_STATES: readonly string[] = ['running', 'pending-confirmation'];

/** Cross-field invariants the schema cannot express. */
function checkInvariants(session: OperatingSession): boolean {
  const ids = new Set<string>();
  const keys = new Set<string>();
  let open: string | undefined;
  for (const [index, turn] of session.turns.entries()) {
    if (turn.index !== index || ids.has(turn.id) || keys.has(turn.submissionKey)) return false;
    ids.add(turn.id);
    keys.add(turn.submissionKey);
    if (OPEN_STATES.includes(turn.state)) {
      if (open !== undefined) return false;
      open = turn.id;
    }
  }
  return session.activeTurnId === (open ?? null);
}

/** Parses and validates a session record. `expectedId` binds the record to its file name. */
export function parseSession(text: string, expectedId?: string): OperatingSession {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw corrupt();
  }
  if (hasForbiddenKey(value)) throw corrupt();
  const parsed = sessionSchema.safeParse(value);
  if (!parsed.success) throw corrupt();
  // Zod omits absent optional keys, so this matches the exact-optional contract types at runtime.
  const session = parsed.data as unknown as OperatingSession;
  if ((expectedId !== undefined && session.id !== expectedId) || !checkInvariants(session)) {
    throw corrupt();
  }
  return session;
}

/** Validates then serializes; a session that would not read back is never written. */
export function serializeSession(session: OperatingSession): string {
  const parsed = sessionSchema.safeParse(session);
  if (!parsed.success || !checkInvariants(session)) {
    throw new NexarError('VALIDATION_ERROR', 'Session record is invalid', {
      details: { reason: 'invalid-record' },
    });
  }
  return JSON.stringify(parsed.data);
}
