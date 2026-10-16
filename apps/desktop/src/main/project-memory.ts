import { z } from 'zod';
import { NexarError } from '@nexar/contracts';
import {
  MAX_MEMORY_TEXT_CHARS,
  MEMORY_ID_PATTERN,
  PROJECT_MEMORY_KINDS,
  isValidMemoryText,
  type ProjectMemoryEntry,
} from '@nexar/project-memory';
import { SESSION_ID_PATTERN, TURN_ID_PATTERN } from '@nexar/sessions';
import type { ProjectMemoryDto } from '../shared/api.js';
import { CHANNELS } from '../shared/channels.js';
import {
  ProjectIdSchema,
  defineChannel,
  requireProject,
  type CallContext,
  type ChannelDefinition,
  type ProjectMemoryService,
} from './channel.js';

/*
 * Owner-only project memory (ADR-030 §7). These three channels are the only way to write it: no
 * model, tool or workflow path can. Writes need the sessions lease (the store checks it). DTOs carry
 * ids, kind, text and a timestamp, never paths.
 */

const KindSchema = z.enum(PROJECT_MEMORY_KINDS);
const EntryIdSchema = z.string().regex(MEMORY_ID_PATTERN);
const TextSchema = z
  .string()
  .min(1)
  .max(MAX_MEMORY_TEXT_CHARS)
  .refine((s) => isValidMemoryText(s.trim()), 'must be text without control characters');

export const ProjectMemoryListSchema = z.strictObject({ projectId: ProjectIdSchema });
export const ProjectMemoryAddSchema = z.strictObject({
  projectId: ProjectIdSchema,
  kind: KindSchema,
  text: TextSchema,
  sessionId: z.string().regex(SESSION_ID_PATTERN).optional(),
  turnId: z.string().regex(TURN_ID_PATTERN).optional(),
});
export const ProjectMemoryRemoveSchema = z.strictObject({
  projectId: ProjectIdSchema,
  entryId: EntryIdSchema,
});

function memoryStore(ctx: CallContext): ProjectMemoryService {
  const store = ctx.deps.projectMemory;
  if (store === undefined) {
    throw new NexarError('CONFLICT', 'Project memory is not available');
  }
  return store;
}

function toDto(entry: ProjectMemoryEntry): ProjectMemoryDto {
  return { id: entry.id, kind: entry.kind, text: entry.text, createdAt: entry.createdAt };
}

export const projectMemoryChannels: Readonly<Record<string, ChannelDefinition>> = {
  [CHANNELS.projectMemoryList]: defineChannel(ProjectMemoryListSchema, async (args, ctx) => {
    const store = memoryStore(ctx);
    const project = requireProject(ctx, args.projectId);
    return (await store.list(project.id)).map(toDto);
  }),
  [CHANNELS.projectMemoryAdd]: defineChannel(ProjectMemoryAddSchema, async (args, ctx) => {
    const store = memoryStore(ctx);
    const project = requireProject(ctx, args.projectId);
    const entry = await store.add(project.id, {
      kind: args.kind,
      text: args.text,
      ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
      ...(args.turnId === undefined ? {} : { turnId: args.turnId }),
    });
    return toDto(entry);
  }),
  [CHANNELS.projectMemoryRemove]: defineChannel(ProjectMemoryRemoveSchema, async (args, ctx) => {
    const store = memoryStore(ctx);
    const project = requireProject(ctx, args.projectId);
    await store.remove(project.id, args.entryId);
    return { removed: true };
  }),
};
