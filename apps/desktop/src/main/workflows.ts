import { z } from 'zod';
import type { WorkflowDto } from '../shared/api.js';
import { CHANNELS } from '../shared/channels.js';
import { toArtifactDto } from './artifacts.js';
import {
  ProjectIdSchema,
  RequestIdSchema,
  defineChannel,
  requireProject,
  type ChannelDefinition,
} from './channel.js';
import { progressEmitter, toTaskResult } from './tasks.js';

const MAX_INPUT_CHARS = 100_000;
const MAX_LIST_ITEMS = 500;

const InputValue = z.union([
  z
    .string()
    .max(MAX_INPUT_CHARS)
    .refine((s) => !s.includes('\0'), 'must not contain NUL'),
  z.array(z.string().max(MAX_INPUT_CHARS)).max(MAX_LIST_ITEMS),
]);

const RunSchema = z.strictObject({
  requestId: RequestIdSchema,
  projectId: ProjectIdSchema,
  workflowId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  // Names are letters and digits (the workflow definition's own rule); the runner validates values.
  inputs: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/), InputValue),
});

export const workflowChannels: Readonly<Record<string, ChannelDefinition>> = {
  [CHANNELS.workflowsList]: defineChannel(
    z.strictObject({ projectId: ProjectIdSchema.optional() }),
    (args, ctx) => {
      const { catalog } = ctx.deps.engine.workflows();
      return Promise.resolve(
        catalog.list(args.projectId).map((w): WorkflowDto => ({ ...w.summary })),
      );
    },
  ),
  [CHANNELS.workflowsRun]: defineChannel(RunSchema, async (args, ctx) => {
    const project = requireProject(ctx, args.projectId);
    const { runner } = ctx.deps.engine.workflows();
    const controller = ctx.jobs.begin(args.requestId);
    try {
      ctx.emit({ requestId: args.requestId, type: 'status', message: 'Preparing the workflow' });
      // The runner validates every input and wraps it as untrusted text; documents stay references.
      const prepared = await runner.prepare({
        workflowId: args.workflowId,
        projectId: args.projectId,
        inputs: args.inputs,
        origin: { source: 'desktop', project: args.projectId, correlationId: args.requestId },
      });
      const run = await runner.run(prepared, {
        signal: controller.signal,
        onEvent: progressEmitter(ctx, args.requestId),
      });
      const taskId = run.outcome.task.id;
      const artifacts = run.artifacts.map((ref) => toArtifactDto(project, ref, taskId));
      return toTaskResult(run.outcome, artifacts, run.result.text);
    } finally {
      ctx.jobs.end(args.requestId);
    }
  }),
};
