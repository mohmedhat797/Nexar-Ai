import { NEXAR_ERROR_CODES } from '@nexar/contracts';
import { z } from 'zod';
import {
  MAX_DIFF_FILES,
  MAX_GOAL_CHARS,
  MAX_OUTCOME_LANES,
  MAX_REPORT_BYTES,
  PLANE_PROTOCOL,
} from './limits.js';

/*
 * Strict schemas for every frame of `nexar-plane/1`. There is no generic command, path, environment
 * or executable field anywhere in the protocol (ADR-025 section 1).
 */

export const RUN_ID_PATTERN = /^run_[0-9a-f]{32}$/;
export const APPROVAL_ID_PATTERN = /^apr_[0-9a-f]{32}$/;
/** Same shape as `projectId()` in `@nexar/contracts`. */
export const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
/** Same shapes as `@nexar/sessions`; copied so this package stays dependency-light. */
export const SESSION_ID_PATTERN = /^ses_[0-9a-f]{32}$/;
export const TURN_ID_PATTERN = /^turn_[0-9a-f]{32}$/;
export const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Engineering plan ids (`engineering/plans/<id>`). */
export const PLAN_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const TASK_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/;

const id = (pattern: RegExp): z.ZodString => z.string().regex(pattern);
const nonNegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const boundedText = (max: number): z.ZodString => z.string().min(1).max(max);

const runId = id(RUN_ID_PATTERN);
const approvalId = id(APPROVAL_ID_PATTERN);
const taskId = id(TASK_ID_PATTERN);

// ---- Desktop to plane -----------------------------------------------------------------------

export const initializeFrameSchema = z.strictObject({
  type: z.literal('initialize'),
  // Not a literal: a different version must reach the plane so it can answer with a clear error.
  protocol: boundedText(64),
});

export const lineageSchema = z.strictObject({
  sessionId: id(SESSION_ID_PATTERN),
  turnId: id(TURN_ID_PATTERN),
  correlationId: id(CORRELATION_ID_PATTERN),
  depth: z.number().int().min(0).max(2),
});

export const runFrameSchema = z.strictObject({
  type: z.literal('run'),
  runId,
  planeProject: id(PROJECT_ID_PATTERN),
  goal: z.string().min(1).max(MAX_GOAL_CHARS),
  intent: z.enum(['coding', 'review']),
  planId: id(PLAN_ID_PATTERN).optional(),
  lineage: lineageSchema,
});

export const cancelFrameSchema = z.strictObject({ type: z.literal('cancel'), runId });

export const decideFrameSchema = z.strictObject({
  type: z.literal('decide'),
  approvalId,
  decision: z.enum(['approve', 'deny']),
});

export const diffRequestFrameSchema = z.strictObject({ type: z.literal('diff'), taskId });

export const shutdownFrameSchema = z.strictObject({ type: z.literal('shutdown') });

export const desktopFrameSchema = z.discriminatedUnion('type', [
  initializeFrameSchema,
  runFrameSchema,
  cancelFrameSchema,
  decideFrameSchema,
  diffRequestFrameSchema,
  shutdownFrameSchema,
]);

// ---- Plane to Desktop -----------------------------------------------------------------------

export const readinessSchema = z.strictObject({
  sandbox: z.enum(['ok', 'unavailable']),
  selftest: z.enum(['pass', 'fail', 'skipped']),
  automount: z.enum(['disabled', 'enabled', 'unknown']),
  interop: z.enum(['disabled', 'enabled', 'unknown']),
  kernel: z.string().max(200),
  plans: z.array(id(PLAN_ID_PATTERN)).max(32),
  projects: z.array(id(PROJECT_ID_PATTERN)).max(200),
});

export const readyFrameSchema = z.strictObject({
  type: z.literal('ready'),
  protocol: z.literal(PLANE_PROTOCOL),
  planeVersion: boundedText(64),
  readiness: readinessSchema,
});

const ENGINEERING_STEPS = [
  'task.started',
  'lane.completed',
  'patch.harvested',
  'gate.completed',
  'review.completed',
  'acceptance.decided',
  'commit.created',
  'task.finished',
] as const;

/** Scalar-only progress. Mirrors `EngineeringProgress`; never the goal, prompts, diffs or paths. */
export const progressEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('step'),
    step: z.enum(ENGINEERING_STEPS),
    detail: z
      .record(z.string().max(64), z.union([z.string().max(500), z.number(), z.boolean()]))
      .refine((detail) => Object.keys(detail).length <= 32, 'too many detail keys'),
  }),
  z.strictObject({
    type: z.literal('lane.started'),
    lane: boundedText(64),
    role: boundedText(64),
    round: nonNegative,
  }),
  z.strictObject({
    type: z.literal('awaiting-approval'),
    taskId,
    projectId: id(PROJECT_ID_PATTERN),
    branch: boundedText(200),
    baseCommit: id(COMMIT_PATTERN),
    patchSha256: id(SHA256_PATTERN),
    files: nonNegative,
    gatesPassed: nonNegative,
    reviewVerdict: boundedText(32),
    ttlMs: nonNegative,
  }),
]);

export const progressFrameSchema = z.strictObject({
  type: z.literal('progress'),
  runId,
  event: progressEventSchema,
});

export const approvalSummarySchema = z.strictObject({
  taskId,
  branch: boundedText(200),
  files: nonNegative,
  gatesPassed: nonNegative,
  reviewVerdict: boundedText(32),
  patchSha256: id(SHA256_PATTERN),
  ttlMs: nonNegative,
});

export const approvalRequiredFrameSchema = z.strictObject({
  type: z.literal('approval-required'),
  runId,
  approvalId,
  summary: approvalSummarySchema,
});

export const decidedFrameSchema = z.strictObject({
  type: z.literal('decided'),
  approvalId,
  status: z.enum(['approved', 'denied']),
});

export const reportSchema = z.strictObject({
  // At most MAX_REPORT_BYTES of UTF-8, hence at most that many UTF-16 code units.
  text: boundedText(MAX_REPORT_BYTES),
  truncated: z.boolean(),
});

export const outcomeLaneSchema = z.strictObject({
  role: boundedText(64),
  resourceId: boundedText(128),
});

export const outcomeSchema = z
  .strictObject({
    taskId,
    status: z.enum(['committed', 'reported', 'not-accepted', 'failed', 'cancelled']),
    reason: z.string().max(200).optional(),
    branch: boundedText(200).optional(),
    commit: id(COMMIT_PATTERN).optional(),
    report: reportSchema.optional(),
    lanes: z.array(outcomeLaneSchema).max(MAX_OUTCOME_LANES).optional(),
  })
  .refine((outcome) => outcome.report === undefined || outcome.status === 'reported', {
    message: 'report is only allowed with status reported',
    path: ['report'],
  });

export const completedFrameSchema = z.strictObject({
  type: z.literal('completed'),
  runId,
  outcome: outcomeSchema,
});

export const diffFrameSchema = z.strictObject({
  type: z.literal('diff'),
  taskId,
  text: z.string(),
  truncated: z.boolean(),
  files: z.array(boundedText(1024)).max(MAX_DIFF_FILES),
});

export const errorFrameSchema = z.strictObject({
  type: z.literal('error'),
  runId: runId.optional(),
  code: z.enum(NEXAR_ERROR_CODES),
  message: z.string().max(300),
});

export const planeFrameSchema = z.discriminatedUnion('type', [
  readyFrameSchema,
  progressFrameSchema,
  approvalRequiredFrameSchema,
  decidedFrameSchema,
  completedFrameSchema,
  diffFrameSchema,
  errorFrameSchema,
]);

// ---- Types ----------------------------------------------------------------------------------

export type InitializeFrame = z.infer<typeof initializeFrameSchema>;
export type RunLineage = z.infer<typeof lineageSchema>;
export type RunFrame = z.infer<typeof runFrameSchema>;
export type CancelFrame = z.infer<typeof cancelFrameSchema>;
export type DecideFrame = z.infer<typeof decideFrameSchema>;
export type DiffRequestFrame = z.infer<typeof diffRequestFrameSchema>;
export type ShutdownFrame = z.infer<typeof shutdownFrameSchema>;
export type DesktopFrame = z.infer<typeof desktopFrameSchema>;

export type PlaneReadiness = z.infer<typeof readinessSchema>;
export type ReadyFrame = z.infer<typeof readyFrameSchema>;
export type ProgressEvent = z.infer<typeof progressEventSchema>;
export type ProgressFrame = z.infer<typeof progressFrameSchema>;
export type ApprovalSummary = z.infer<typeof approvalSummarySchema>;
export type ApprovalRequiredFrame = z.infer<typeof approvalRequiredFrameSchema>;
export type DecidedFrame = z.infer<typeof decidedFrameSchema>;
export type RunOutcome = z.infer<typeof outcomeSchema>;
export type CompletedFrame = z.infer<typeof completedFrameSchema>;
export type DiffFrame = z.infer<typeof diffFrameSchema>;
export type ErrorFrame = z.infer<typeof errorFrameSchema>;
export type PlaneFrame = z.infer<typeof planeFrameSchema>;

/** Every `type` a receiver of that direction knows; a different one is an unknown frame type. */
export const DESKTOP_FRAME_TYPES = [
  'initialize',
  'run',
  'cancel',
  'decide',
  'diff',
  'shutdown',
] as const satisfies readonly DesktopFrame['type'][];

export const PLANE_FRAME_TYPES = [
  'ready',
  'progress',
  'approval-required',
  'decided',
  'completed',
  'diff',
  'error',
] as const satisfies readonly PlaneFrame['type'][];
