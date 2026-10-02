import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { NexarError, projectId, type ArtifactRef } from '@nexar/contracts';
import type { OperatingService } from '@nexar/operating';
import type { Project } from '@nexar/projects';
import {
  MAX_TITLE_CHARS,
  SESSION_ID_PATTERN,
  SUBMISSION_KEY_PATTERN,
  TURN_ID_PATTERN,
  type LaneDecision,
  type OperatingSession,
  type SessionSummary,
  type Turn,
  type UnavailableSession,
} from '@nexar/sessions';
import type {
  SessionDto,
  SessionSummaryDto,
  SubmitTurnResult,
  TurnDto,
  TurnLaneDto,
} from '../shared/api.js';
import { CHANNELS } from '../shared/channels.js';
import { toArtifactDto } from './artifacts.js';
import {
  ProjectIdSchema,
  ResourceIdListSchema,
  TaskKindSchema,
  defineChannel,
  requireProject,
  type CallContext,
  type ChannelDefinition,
  type SessionService,
} from './channel.js';
import { PromptSchema } from './tasks.js';

const DEFAULT_TITLE = 'New conversation';
/** Stored identifiers (rule ids, fallback reasons) are constants; anything else never leaves main. */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const SessionIdSchema = z.string().regex(SESSION_ID_PATTERN);
const TurnIdSchema = z.string().regex(TURN_ID_PATTERN);
const SubmissionKeySchema = z.string().regex(SUBMISSION_KEY_PATTERN);
const ModeSchema = z.enum(['cowork', 'code']);
const RevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const TitleSchema = z
  .string()
  .min(1)
  .max(MAX_TITLE_CHARS)
  .refine((s) => !/[\p{Cc}\p{Cf}]/u.test(s), 'must not contain control characters');

const SubmitSchema = z.strictObject({
  sessionId: SessionIdSchema,
  submissionKey: SubmissionKeySchema,
  text: PromptSchema,
  kind: TaskKindSchema.optional(),
  preferredResourceIds: ResourceIdListSchema.optional(),
  maxCostUsd: z.number().finite().nonnegative().max(10_000).optional(),
});

// --- guards -----------------------------------------------------------------------------------

function sessionStore(ctx: CallContext): SessionService {
  const store = ctx.deps.sessions;
  if (store === undefined) {
    throw new NexarError('CONFLICT', 'Sessions are open in another Nexar process');
  }
  return store;
}

async function loadSession(store: SessionService, id: string): Promise<OperatingSession> {
  const session = await store.get(id);
  if (session === undefined) throw new NexarError('VALIDATION_ERROR', 'Unknown session');
  return session;
}

/** The session's own project is authoritative; it must still be configured. */
function sessionProject(ctx: CallContext, session: OperatingSession): Project {
  const project = ctx.deps.engine.composition().runtime.projects.get(projectId(session.projectId));
  if (project === undefined) {
    throw new NexarError('VALIDATION_ERROR', 'The conversation project is no longer available');
  }
  return project;
}

// --- DTOs (renderer-safe: ids, states, bounded text, project-relative artifact paths) ---------

function isUnavailable(entry: SessionSummary | UnavailableSession): entry is UnavailableSession {
  return 'unavailable' in entry;
}

function toSummaryDto(session: SessionSummary): SessionSummaryDto {
  return {
    id: session.id,
    projectId: session.projectId,
    mode: session.mode,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    revision: session.revision,
    turnCount: session.turnCount,
    active: session.activeTurnId !== null,
    ...(session.lastTurnState === undefined ? {} : { lastTurnState: session.lastTurnState }),
  };
}

/** A ref that does not map to a project-relative path inside the project is dropped, never sent. */
function mapArtifact(project: Project, ref: ArtifactRef, forTask: string) {
  try {
    const dto = toArtifactDto(project, ref, forTask);
    const escapes =
      dto.path === '' ||
      isAbsolute(dto.path) ||
      /^[A-Za-z]:/.test(dto.path) ||
      dto.path.split(/[\\/]/).includes('..');
    return escapes ? undefined : dto;
  } catch {
    return undefined;
  }
}

function toLaneDto(lane: LaneDecision): TurnLaneDto {
  return {
    requestedLane: lane.requestedLane,
    effectiveLane: lane.effectiveLane,
    ...(lane.mismatch === undefined
      ? {}
      : { mismatch: { from: lane.mismatch.from, to: lane.mismatch.to } }),
    ...(lane.confirmed === undefined ? {} : { confirmed: lane.confirmed }),
    ...(lane.fallbackReason === undefined || !IDENTIFIER.test(lane.fallbackReason)
      ? {}
      : { fallbackReason: lane.fallbackReason }),
  };
}

function toTurnDto(project: Project, turn: Turn): TurnDto {
  const owner = turn.tasks[0]?.taskId ?? turn.id;
  const artifacts = turn.artifacts.flatMap((ref) => mapArtifact(project, ref, owner) ?? []);
  return {
    id: turn.id,
    index: turn.index,
    text: turn.text,
    state: turn.state,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
    ...(turn.intent === undefined
      ? {}
      : {
          kind: turn.intent.kind,
          intent: {
            kind: turn.intent.kind,
            source: turn.intent.source,
            ruleIds: turn.intent.ruleIds.filter((id) => IDENTIFIER.test(id)),
          },
        }),
    ...(turn.lane === undefined ? {} : { lane: toLaneDto(turn.lane) }),
    tasks: turn.tasks.map((t) => ({
      taskId: t.taskId,
      state: t.state,
      ...(t.resourceId === undefined ? {} : { resourceId: t.resourceId }),
    })),
    artifacts,
    ...(turn.outcome === undefined
      ? {}
      : {
          outcome: {
            ...(turn.outcome.text === undefined ? {} : { text: turn.outcome.text }),
            ...(turn.outcome.textTruncated === undefined
              ? {}
              : { textTruncated: turn.outcome.textTruncated }),
            ...(turn.outcome.error === undefined
              ? {}
              : { error: { code: turn.outcome.error.code, message: turn.outcome.error.message } }),
          },
        }),
  };
}

function toSessionDto(project: Project, session: OperatingSession): SessionDto {
  const last = session.turns[session.turns.length - 1];
  return {
    ...toSummaryDto({
      id: session.id,
      projectId: session.projectId,
      mode: session.mode,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      revision: session.revision,
      turnCount: session.turns.length,
      activeTurnId: session.activeTurnId,
      ...(last === undefined ? {} : { lastTurnState: last.state }),
    }),
    turns: session.turns.map((t) => toTurnDto(project, t)),
  };
}

// --- turn pipeline ----------------------------------------------------------------------------

function operatingOf(ctx: CallContext): OperatingService {
  if (ctx.operating === undefined) {
    throw new NexarError('CONFLICT', 'Sessions are open in another Nexar process');
  }
  return ctx.operating;
}

async function submitTurn(
  ctx: CallContext,
  args: z.output<typeof SubmitSchema>,
): Promise<SubmitTurnResult> {
  const operating = operatingOf(ctx);
  const session = await loadSession(sessionStore(ctx), args.sessionId);
  const project = sessionProject(ctx, session);
  const result = await operating.submit({
    sessionId: args.sessionId,
    submissionKey: args.submissionKey,
    text: args.text,
    ...(args.kind === undefined ? {} : { explicitKind: args.kind }),
    ...(args.preferredResourceIds === undefined
      ? {}
      : { preferredResourceIds: args.preferredResourceIds }),
    ...(args.maxCostUsd === undefined ? {} : { maxCostUsd: args.maxCostUsd }),
  });
  return { turn: toTurnDto(project, result.turn), created: result.created, action: result.action };
}

// --- channels ---------------------------------------------------------------------------------

export const sessionChannels: Readonly<Record<string, ChannelDefinition>> = {
  [CHANNELS.sessionsList]: defineChannel(
    z.strictObject({ projectId: ProjectIdSchema }),
    async (args, ctx) => {
      const store = sessionStore(ctx);
      requireProject(ctx, args.projectId);
      const entries = await store.list();
      return entries
        .filter((e): e is SessionSummary => !isUnavailable(e) && e.projectId === args.projectId)
        .map(toSummaryDto);
    },
  ),
  [CHANNELS.sessionsCreate]: defineChannel(
    z.strictObject({
      projectId: ProjectIdSchema,
      mode: ModeSchema,
      title: TitleSchema.optional(),
    }),
    async (args, ctx) => {
      const store = sessionStore(ctx);
      const project = requireProject(ctx, args.projectId);
      const session = await store.create({
        projectId: project.id,
        mode: args.mode,
        title: args.title ?? DEFAULT_TITLE,
      });
      return toSessionDto(project, session);
    },
  ),
  [CHANNELS.sessionsGet]: defineChannel(
    z.strictObject({ sessionId: SessionIdSchema }),
    async (args, ctx) => {
      const session = await loadSession(sessionStore(ctx), args.sessionId);
      return toSessionDto(sessionProject(ctx, session), session);
    },
  ),
  [CHANNELS.sessionsSubmitTurn]: defineChannel(SubmitSchema, (args, ctx) => submitTurn(ctx, args)),
  [CHANNELS.sessionsConfirmLane]: defineChannel(
    z.strictObject({
      sessionId: SessionIdSchema,
      turnId: TurnIdSchema,
      decision: z.enum(['confirm', 'decline']),
    }),
    async (args, ctx) => {
      const operating = operatingOf(ctx);
      const session = await loadSession(sessionStore(ctx), args.sessionId);
      const project = sessionProject(ctx, session);
      if (!session.turns.some((t) => t.id === args.turnId)) {
        throw new NexarError('VALIDATION_ERROR', 'Unknown turn');
      }
      // Choosing a lane for this turn only: no scope, mode or sandbox requirement changes.
      return toTurnDto(project, await operating.confirm(args));
    },
  ),
  [CHANNELS.sessionsCancel]: defineChannel(
    z.strictObject({ sessionId: SessionIdSchema, turnId: TurnIdSchema }),
    async (args, ctx) => {
      const operating = operatingOf(ctx);
      const session = await loadSession(sessionStore(ctx), args.sessionId);
      if (!session.turns.some((t) => t.id === args.turnId)) {
        throw new NexarError('VALIDATION_ERROR', 'Unknown turn');
      }
      return { cancelled: operating.cancel(args.sessionId, args.turnId) };
    },
  ),
  [CHANNELS.sessionsSetMode]: defineChannel(
    z.strictObject({
      sessionId: SessionIdSchema,
      mode: ModeSchema,
      expectedRevision: RevisionSchema.optional(),
    }),
    async (args, ctx) => {
      const store = sessionStore(ctx);
      const project = sessionProject(ctx, await loadSession(store, args.sessionId));
      const updated = await store.setMode(args.sessionId, args.mode, args.expectedRevision);
      return toSessionDto(project, updated);
    },
  ),
  [CHANNELS.sessionsRename]: defineChannel(
    z.strictObject({
      sessionId: SessionIdSchema,
      title: TitleSchema,
      expectedRevision: RevisionSchema.optional(),
    }),
    async (args, ctx) => {
      const store = sessionStore(ctx);
      const project = sessionProject(ctx, await loadSession(store, args.sessionId));
      const updated = await store.rename(args.sessionId, args.title, args.expectedRevision);
      return toSessionDto(project, updated);
    },
  ),
};
