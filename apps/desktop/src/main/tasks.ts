import { z } from 'zod';
import { LocalArtifactStore } from '@nexar/artifacts';
import {
  isNexarError,
  resourceId,
  type ArtifactRef,
  type ExecutionEvent,
  type Measured,
  type NexarTask,
} from '@nexar/contracts';
import type { RunOutcome } from '@nexar/core';
import type { Project } from '@nexar/projects';
import type { ArtifactDto, MeasuredNumber, TaskResult } from '../shared/api.js';
import { CHANNELS } from '../shared/channels.js';
import { toArtifactDto } from './artifacts.js';
import type { EngineHost } from './engine-host.js';
import {
  ProjectIdSchema,
  RequestIdSchema,
  ResourceIdListSchema,
  TaskKindSchema,
  asProjectId,
  defineChannel,
  requireProject,
  type CallContext,
  type ChannelDefinition,
} from './channel.js';

const MAX_PROMPT_CHARS = 100_000;
const MAX_EVENT_CHARS = 300;

export const PromptSchema = z
  .string()
  .min(1)
  .max(MAX_PROMPT_CHARS)
  .refine((s) => !s.includes('\0'), 'must not contain NUL');

const RouteSchema = {
  projectId: ProjectIdSchema,
  kind: TaskKindSchema,
  prompt: PromptSchema,
  preferredResourceIds: ResourceIdListSchema.optional(),
};
const RouteArgsSchema = z.strictObject(RouteSchema);
const RunArgsSchema = z.strictObject({
  requestId: RequestIdSchema,
  ...RouteSchema,
  maxCostUsd: z.number().finite().nonnegative().max(10_000).optional(),
});

export function oneLine(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, MAX_EVENT_CHARS);
}

/** Status and tool-name progress only: text deltas and tool details never leave the engine. */
export function progressLine(
  event: ExecutionEvent,
): { readonly type: 'status' | 'progress'; readonly message: string } | undefined {
  if (event.type === 'status') return { type: 'status', message: oneLine(event.message) };
  if (event.type === 'tool-call') return { type: 'progress', message: oneLine(event.name) };
  return undefined;
}

export function progressEmitter(
  ctx: CallContext,
  requestId: string,
): (event: ExecutionEvent) => void {
  return (event) => {
    const line = progressLine(event);
    if (line !== undefined) ctx.emit({ requestId, ...line });
  };
}

export function toMeasuredNumber(value: Measured<number>): MeasuredNumber {
  return value.status === 'unavailable'
    ? { status: 'unavailable' }
    : { status: value.status, value: value.value };
}

export interface TaskArgs {
  readonly projectId: string;
  readonly kind: string;
  readonly prompt: string;
  readonly preferredResourceIds?: readonly string[] | undefined;
  readonly maxCostUsd?: number | undefined;
  /** Set by Nexar only (never from a request): the Cowork lane excludes resources OpenWorker cannot use. */
  readonly excludedResourceIds?: readonly string[] | undefined;
}

/** Operating Session lineage (ADR-024 section 2); set by Nexar, never taken from a request. */
export interface TaskLineage {
  readonly sessionId: string;
  readonly turnId: string;
}

/** The task for a desktop request. The working directory is the project's (enforced by the engine). */
export function createTask(
  ctx: CallContext,
  args: TaskArgs,
  requestId: string | undefined,
  lineage?: TaskLineage,
): NexarTask {
  return newTask(ctx.deps.engine, args, requestId, lineage);
}

/** createTask over the engine alone, for callers that have no call context. */
export function newTask(
  engine: EngineHost,
  args: TaskArgs,
  requestId: string | undefined,
  lineage?: TaskLineage,
): NexarTask {
  const { nexar } = engine.composition().runtime;
  const preferred = args.preferredResourceIds ?? [];
  return nexar.createTask({
    kind: args.kind,
    prompt: args.prompt,
    projectId: args.projectId,
    origin: {
      source: 'desktop',
      project: args.projectId,
      ...(requestId === undefined ? {} : { correlationId: requestId }),
      ...(lineage === undefined ? {} : { sessionId: lineage.sessionId, turnId: lineage.turnId }),
    },
    requirements: {
      capabilities: [],
      ...(preferred.length === 0 ? {} : { preferredResourceIds: preferred.map(resourceId) }),
      ...(args.maxCostUsd === undefined ? {} : { maxCostUsd: args.maxCostUsd }),
      ...(args.excludedResourceIds === undefined || args.excludedResourceIds.length === 0
        ? {}
        : { excludedResourceIds: args.excludedResourceIds.map(resourceId) }),
    },
  });
}

/** Maps an outcome to the renderer's result shape; `artifacts` are already stored. */
export function toTaskResult(
  outcome: RunOutcome,
  artifacts: readonly ArtifactDto[],
  text: string,
): TaskResult {
  const { record, decision, task } = outcome;
  return {
    taskId: task.id,
    decision,
    text,
    artifact: artifacts[0] ?? null,
    artifacts,
    record: {
      resourceId: record.resourceId,
      model: record.model ?? null,
      outcome: record.outcome,
      latencyMs: record.latencyMs,
      costUsd: toMeasuredNumber(record.usage.costUsd),
    },
  };
}

/** Stores the result as a draft, like the Work Bridge; a storage failure never loses the text. */
export async function storeDraftRef(
  ctx: CallContext,
  project: Project,
  outcome: RunOutcome,
): Promise<ArtifactRef | undefined> {
  const { runtime } = ctx.deps.engine.composition();
  try {
    const store = new LocalArtifactStore({ projects: runtime.projects });
    const ref = await store.store({
      projectId: asProjectId(project.id),
      taskId: outcome.task.id,
      filename: 'result.md',
      content: outcome.result.text,
      mediaType: 'text/markdown',
      draft: true,
    });
    await runtime.nexar.recordArtifacts(outcome.task.id, project.id, [ref]);
    return ref;
  } catch (error) {
    ctx.deps.logger.warn('storing the result artifact failed', {
      code: isNexarError(error) ? error.code : 'UNKNOWN',
    });
    return undefined;
  }
}

async function storeDraft(
  ctx: CallContext,
  project: Project,
  outcome: RunOutcome,
): Promise<ArtifactDto[]> {
  const ref = await storeDraftRef(ctx, project, outcome);
  return ref === undefined ? [] : [toArtifactDto(project, ref, outcome.task.id)];
}

async function runTask(
  ctx: CallContext,
  args: z.output<typeof RunArgsSchema>,
): Promise<TaskResult> {
  const project = requireProject(ctx, args.projectId);
  const { nexar } = ctx.deps.engine.composition().runtime;
  const controller = ctx.jobs.begin(args.requestId);
  try {
    ctx.emit({ requestId: args.requestId, type: 'status', message: 'Routing the task' });
    const task = createTask(ctx, args, args.requestId);
    const outcome = await nexar.run(task, {
      signal: controller.signal,
      onEvent: progressEmitter(ctx, args.requestId),
    });
    const artifacts = await storeDraft(ctx, project, outcome);
    return toTaskResult(outcome, artifacts, outcome.result.text);
  } finally {
    ctx.jobs.end(args.requestId);
  }
}

export const taskChannels: Readonly<Record<string, ChannelDefinition>> = {
  [CHANNELS.routeExplain]: defineChannel(RouteArgsSchema, async (args, ctx) => {
    requireProject(ctx, args.projectId);
    const { nexar } = ctx.deps.engine.composition().runtime;
    return nexar.route(createTask(ctx, args, undefined));
  }),
  [CHANNELS.tasksRun]: defineChannel(RunArgsSchema, (args, ctx) => runTask(ctx, args)),
  [CHANNELS.tasksCancel]: defineChannel(
    z.strictObject({ requestId: RequestIdSchema }),
    (args, ctx) => Promise.resolve({ cancelled: ctx.jobs.abort(args.requestId) }),
  ),
};
