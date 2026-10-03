import { z } from 'zod';
import { NexarError } from '@nexar/contracts';
import { SESSION_ID_PATTERN, TURN_ID_PATTERN } from '@nexar/sessions';
import type { PlaneStatusDto } from '../shared/api.js';
import { CHANNELS } from '../shared/channels.js';
import type { CodePlane } from './code-plane.js';
import {
  ProjectIdSchema,
  defineChannel,
  requireProject,
  type CallContext,
  type ChannelDefinition,
} from './channel.js';
import { PLANE_PROJECT_PATTERN } from './settings-store.js';

/*
 * The Code lane surface (ADR-025). The renderer names a Desktop project by id and a plane project
 * by id; it can never supply a distro, command, argument, environment variable or path.
 */

function codePlane(ctx: CallContext): CodePlane {
  const plane = ctx.deps.codePlane;
  if (plane === undefined) {
    throw new NexarError('CONFLICT', 'The Code lane is not available in this session');
  }
  return plane;
}

async function statusDto(
  ctx: CallContext,
  projectId: string | undefined,
  force: boolean,
): Promise<PlaneStatusDto> {
  const plane = codePlane(ctx);
  if (projectId !== undefined) requireProject(ctx, projectId);
  await plane.reloadConfig();
  const status = force ? await plane.refresh() : await plane.status();
  return {
    ...status,
    ...(projectId === undefined ? {} : { project: plane.projectOf(status, projectId) }),
  };
}

const OptionalProject = z.strictObject({ projectId: ProjectIdSchema.optional() });

export const codeChannels: Readonly<Record<string, ChannelDefinition>> = {
  [CHANNELS.codeStatus]: defineChannel(OptionalProject, (args, ctx) =>
    statusDto(ctx, args.projectId, false),
  ),
  [CHANNELS.codeRefresh]: defineChannel(OptionalProject, (args, ctx) =>
    statusDto(ctx, args.projectId, true),
  ),
  [CHANNELS.codeSetPlaneProject]: defineChannel(
    z.strictObject({
      projectId: ProjectIdSchema,
      planeProject: z.string().regex(PLANE_PROJECT_PATTERN).nullable(),
    }),
    async (args, ctx) => {
      const plane = codePlane(ctx);
      requireProject(ctx, args.projectId);
      await ctx.deps.settings.setPlaneProject(args.projectId, args.planeProject);
      await plane.reloadConfig();
      return statusDto(ctx, args.projectId, false);
    },
  ),
  [CHANNELS.codeDiff]: defineChannel(
    z.strictObject({
      sessionId: z.string().regex(SESSION_ID_PATTERN),
      turnId: z.string().regex(TURN_ID_PATTERN),
    }),
    (args, ctx) => {
      const diff = codePlane(ctx).diff(args.sessionId, args.turnId);
      if (diff === undefined) {
        return Promise.reject(
          new NexarError('VALIDATION_ERROR', 'No diff is available for this turn'),
        );
      }
      return Promise.resolve(diff);
    },
  ),
};
