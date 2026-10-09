import { NEXAR_ERROR_CODES } from '@nexar/contracts';
import { z } from 'zod';
import {
  MAX_DIFF_FILES,
  MAX_GOAL_CHARS,
  MAX_OUTCOME_LANES,
  MAX_REPORT_BYTES,
  MAX_REQUIRED_CONTEXT_CHARS,
  MAX_TITLE_CHARS,
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
/** One line with visible text: no control character and no Unicode line or paragraph separator. */
// eslint-disable-next-line no-control-regex
export const RUN_TITLE_PATTERN = /^(?=.*\S)[^\x00-\x1f\x7f\u0085\u2028\u2029]+$/;
const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/;

const id = (pattern: RegExp): z.ZodString => z.string().regex(pattern);
const nonNegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const boundedText = (max: number): z.ZodString => z.string().min(1).max(max);

/**
 * Optional protocol features a Desktop can request in `initialize`. `required-context`: the plane
 * accepts `run.requiredContext` and says so in `readiness.features`. An older plane rejects an
 * `initialize` that lists it, so a Desktop retries without it (see `CodePlane.probe`).
 */
export const PLANE_FEATURES = ['resources', 'required-context'] as const;
/** Same shape as `resourceId()` in `@nexar/contracts`. */
export const RESOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

const runId = id(RUN_ID_PATTERN);
const approvalId = id(APPROVAL_ID_PATTERN);
const taskId = id(TASK_ID_PATTERN);

// ---- Desktop to plane -----------------------------------------------------------------------

export const initializeFrameSchema = z.strictObject({
  type: z.literal('initialize'),
  // Not a literal: a different version must reach the plane so it can answer with a clear error.
  protocol: boundedText(64),
  /**
   * Optional features this Desktop understands (additive). The plane adds `readiness.resources` only
   * when `resources` is listed, so a Desktop with the strict readiness schema never receives it.
   */
  features: z
    .array(z.enum(PLANE_FEATURES))
    .max(8)
    .refine((features) => new Set(features).size === features.length, 'duplicate feature')
    .optional(),
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
  /**
   * The owner's request as one line (optional, additive): the commit subject derives from it, never
   * from the goal's context header. Without it the plane falls back to the goal's first line.
   */
  title: z.string().max(MAX_TITLE_CHARS).regex(RUN_TITLE_PATTERN).optional(),
  /**
   * Owner-confirmed project memory (optional, additive): sent only to a plane that listed
   * `required-context` in `readiness.features`; an older plane rejects the key. Never recorded or logged.
   */
  requiredContext: z.string().min(1).max(MAX_REQUIRED_CONTEXT_CHARS).optional(),
  intent: z.enum(['coding', 'review', 'plan']),
  planId: id(PLAN_ID_PATTERN).optional(),
  lineage: lineageSchema,
});

// eslint-disable-next-line no-control-regex
const TITLE_UNSAFE = /[\x00-\x1f\x7f]/g;

/**
 * The first line of the owner's text with visible content, as a `run` title: control characters
 * become spaces, whitespace collapses, cut to `MAX_TITLE_CHARS` without splitting a surrogate pair.
 * `undefined` when the text has no visible line.
 */
export function runTitle(text: string): string | undefined {
  for (const line of text.split(/[\n\r\u0085\u2028\u2029]/)) {
    const clean = line.replace(TITLE_UNSAFE, ' ').replace(/\s+/g, ' ').trim();
    if (clean === '') continue;
    let title = '';
    for (const char of clean) {
      if (title.length + char.length > MAX_TITLE_CHARS) break;
      title += char;
    }
    return title.trimEnd();
  }
  return undefined;
}

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

/** One plane resource: ids and enums only; no detail text, path or secret (ADR-027 section 11). */
export const planeResourceSchema = z.strictObject({
  id: id(RESOURCE_ID_PATTERN),
  connection: z
    .strictObject({
      id: boundedText(200),
      provider: boundedText(200),
      method: z.enum(['subscription', 'api', 'local', 'custom']),
      authClass: z.enum([
        'vendor-native',
        'official-api',
        'official-account',
        'experimental-client-compat',
        'none',
      ]),
      support: z.enum(['official', 'experimental']),
    })
    .optional(),
  auth: z.enum(['authenticated', 'unauthenticated', 'not-required', 'unknown']),
  availability: z.enum(['available', 'degraded', 'unavailable', 'unknown']),
  // legacy (ADR-030): read-only. Planes of older builds still send the retired engine flag; it is never used.
  control: z.strictObject({ openworker: z.boolean().optional(), dsh: z.boolean() }),
});

/** The plane's owner policy for the Code lane's control resource (`orchestration.code`). */
export const planeControlSchema = z.strictObject({
  code: z.strictObject({
    mode: z.enum(['auto', 'pinned']),
    resourceId: id(RESOURCE_ID_PATTERN).optional(),
    fallback: z.enum(['auto', 'none']),
  }),
});

export const readinessSchema = z.strictObject({
  sandbox: z.enum(['ok', 'unavailable']),
  selftest: z.enum(['pass', 'fail', 'skipped']),
  automount: z.enum(['disabled', 'enabled', 'unknown']),
  interop: z.enum(['disabled', 'enabled', 'unknown']),
  kernel: z.string().max(200),
  plans: z.array(id(PLAN_ID_PATTERN)).max(32),
  projects: z.array(id(PROJECT_ID_PATTERN)).max(200),
  /** Only sent when `initialize` requested the `resources` feature. */
  resources: z.array(planeResourceSchema).max(64).optional(),
  /** Only sent when `initialize` requested the `resources` feature. */
  control: planeControlSchema.optional(),
  /** Only sent when `initialize` requested `required-context`: the features this plane accepts. */
  features: z
    .array(z.enum(PLANE_FEATURES))
    .max(8)
    .refine((features) => new Set(features).size === features.length, 'duplicate feature')
    .optional(),
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
  // Additive, only sent when `initialize` requested `resources`: who orchestrated a write lane.
  executor: z.enum(['engine', 'native']).optional(),
  // legacy (ADR-030): read-only; the retired engine id only on lanes recorded by older planes.
  engine: z.enum(['openworker', 'dsh']).optional(),
  executorReason: boundedText(64).optional(),
  controlResourceId: id(RESOURCE_ID_PATTERN).optional(),
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

export type PlaneFeature = (typeof PLANE_FEATURES)[number];
export type PlaneResource = z.infer<typeof planeResourceSchema>;
export type PlaneControl = z.infer<typeof planeControlSchema>;
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
