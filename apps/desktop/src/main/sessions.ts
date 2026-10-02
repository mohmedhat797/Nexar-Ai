import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { NexarError, isNexarError, projectId, type ArtifactRef } from '@nexar/contracts';
import type { Project } from '@nexar/projects';
import {
  MAX_TITLE_CHARS,
  SESSION_ID_PATTERN,
  SUBMISSION_KEY_PATTERN,
  TURN_ID_PATTERN,
  type OperatingSession,
  type SessionSummary,
  type Turn,
  type UnavailableSession,
} from '@nexar/sessions';
import type {
  SessionDto,
  SessionEvent,
  SessionSummaryDto,
  SubmitTurnResult,
  TurnDto,
} from '../shared/api.js';
import { CHANNELS } from '../shared/channels.js';
import { toArtifactDto } from './artifacts.js';
import {
  ProjectIdSchema,
  ResourceIdListSchema,
  TaskKindSchema,
  defineChannel,
  requireProject,
  safeError,
  type CallContext,
  type ChannelDefinition,
  type SessionService,
} from './channel.js';
import { PromptSchema, createTask, progressLine, storeDraftRef } from './tasks.js';

const DEFAULT_TITLE = 'New conversation';
/** Names the policy that picked the intent; there is no rule-based classifier or lane router yet. */
const INTENT_POLICY = 'desktop-explicit@1';

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
  kind: TaskKindSchema,
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
    ...(turn.intent === undefined ? {} : { kind: turn.intent.kind }),
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

// --- turn execution ---------------------------------------------------------------------------

interface TurnRun {
  readonly project: Project;
  readonly sessionId: string;
  readonly turn: Turn;
  readonly controller: AbortController;
  readonly kind: string;
  readonly preferredResourceIds: readonly string[] | undefined;
  readonly maxCostUsd: number | undefined;
}

/** Logs the code only; a store failure must never take the app down or leak a path. */
async function attempt(
  ctx: CallContext,
  what: string,
  work: () => Promise<unknown>,
): Promise<void> {
  try {
    await work();
  } catch (error) {
    ctx.deps.logger.warn(`session update failed: ${what}`, {
      code: isNexarError(error) ? error.code : 'UNKNOWN',
    });
  }
}

/**
 * Runs one turn in the background: task -> route -> execute -> draft -> durable outcome. The turn
 * is already stored as `running`; whatever happens here ends in a terminal state (or, if even the
 * store is failing, stays `running` until the next restart marks it `interrupted`).
 *
 * The prompt is this turn's text only. Bounded multi-turn context is assembled by the Operating
 * Layer in a later unit (ADR-024 section 10, context@1); until then turns do not see each other.
 */
async function executeTurn(ctx: CallContext, run: TurnRun): Promise<void> {
  const store = sessionStore(ctx);
  const { sessionId, turn, controller } = run;
  const emit = (type: SessionEvent['type'], message?: string): void =>
    ctx.emitSession({
      sessionId,
      turnId: turn.id,
      type,
      ...(message === undefined ? {} : { message }),
    });
  let linkedTaskId: string | undefined;
  try {
    emit('status', 'Routing the task');
    const { nexar } = ctx.deps.engine.composition().runtime;
    const task = createTask(
      ctx,
      {
        projectId: run.project.id,
        kind: run.kind,
        prompt: turn.text,
        preferredResourceIds: run.preferredResourceIds,
        maxCostUsd: run.maxCostUsd,
      },
      turn.id,
      { sessionId, turnId: turn.id },
    );
    await store.linkTask(sessionId, turn.id, { taskId: task.id, state: 'running' });
    linkedTaskId = task.id;
    emit('turn');

    const outcome = await nexar.run(task, {
      signal: controller.signal,
      onEvent: (event) => {
        const line = progressLine(event);
        if (line !== undefined) emit(line.type, line.message);
      },
    });

    const ref = await storeDraftRef(ctx, run.project, outcome);
    if (ref !== undefined) await store.linkArtifacts(sessionId, turn.id, [ref]);
    const { decision } = outcome;
    await store.updateTask(sessionId, turn.id, task.id, {
      state: 'succeeded',
      resourceId: outcome.record.resourceId,
      policyId: `${decision.policy.name}@${decision.policy.version}`,
      fallback: decision.policy.fallback !== undefined,
    });
    await store.completeTurn(sessionId, turn.id, {
      state: 'succeeded',
      outcome: { text: outcome.result.text },
    });
  } catch (error) {
    const cancelled = controller.signal.aborted;
    if (linkedTaskId !== undefined) {
      const taskId = linkedTaskId;
      await attempt(ctx, 'task', () =>
        store.updateTask(sessionId, turn.id, taskId, {
          state: cancelled ? 'cancelled' : 'failed',
        }),
      );
    }
    await attempt(ctx, 'turn', () =>
      store.completeTurn(
        sessionId,
        turn.id,
        cancelled
          ? { state: 'cancelled' }
          : { state: 'failed', outcome: { error: safeError(error) } },
      ),
    );
  } finally {
    ctx.jobs.end(turn.id);
    emit('turn');
  }
}

async function submitTurn(
  ctx: CallContext,
  args: z.output<typeof SubmitSchema>,
): Promise<SubmitTurnResult> {
  const store = sessionStore(ctx);
  const session = await loadSession(store, args.sessionId);
  const project = sessionProject(ctx, session);
  const { turn, created } = await store.beginTurn(args.sessionId, {
    submissionKey: args.submissionKey,
    text: args.text,
    state: 'running',
    intent: { kind: args.kind, source: 'explicit', ruleIds: [], policy: INTENT_POLICY },
  });
  if (!created) return { turn: toTurnDto(project, turn), created: false };

  ctx.emitSession({ sessionId: args.sessionId, turnId: turn.id, type: 'turn' });
  let controller: AbortController;
  try {
    controller = ctx.jobs.begin(turn.id);
  } catch (error) {
    // No capacity to run it: the stored turn must not stay "running" and block the session.
    await attempt(ctx, 'turn', () =>
      store.completeTurn(args.sessionId, turn.id, {
        state: 'failed',
        outcome: { error: safeError(error) },
      }),
    );
    ctx.emitSession({ sessionId: args.sessionId, turnId: turn.id, type: 'turn' });
    throw error;
  }
  // Fire and forget: `executeTurn` never rejects (every failure ends in the turn's state).
  void executeTurn(ctx, {
    project,
    sessionId: args.sessionId,
    turn,
    controller,
    kind: args.kind,
    preferredResourceIds: args.preferredResourceIds,
    maxCostUsd: args.maxCostUsd,
  }).catch((error: unknown) => {
    ctx.deps.logger.error('session turn crashed', {
      errorName: error instanceof Error ? error.name : 'unknown',
    });
  });
  return { turn: toTurnDto(project, turn), created: true };
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
  [CHANNELS.sessionsCancel]: defineChannel(
    z.strictObject({ sessionId: SessionIdSchema, turnId: TurnIdSchema }),
    async (args, ctx) => {
      const session = await loadSession(sessionStore(ctx), args.sessionId);
      const turn = session.turns.find((t) => t.id === args.turnId);
      if (turn === undefined) throw new NexarError('VALIDATION_ERROR', 'Unknown turn');
      return { cancelled: turn.state === 'running' && ctx.jobs.abort(turn.id) };
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
