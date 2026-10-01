import { readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { EXTENSION_BY_MEDIA_TYPE, LocalArtifactStore } from '@nexar/artifacts';
import { NexarError, taskId, type ArtifactRef } from '@nexar/contracts';
import { isWithin, resolveContainedPath, type Project } from '@nexar/projects';
import type { ArtifactDto } from '../shared/api.js';
import { CHANNELS } from '../shared/channels.js';
import {
  ProjectIdSchema,
  RelativePathSchema,
  asProjectId,
  defineChannel,
  outsideBoundary,
  requireProject,
  resolveProjectPath,
  toProjectRelative,
  type CallContext,
  type ChannelDefinition,
} from './channel.js';

const MAX_TASK_DIRECTORIES = 100;
/**
 * Only the file types the artifact store itself writes may reach the OS default handler, so a file
 * planted under the artifacts directory (e.g. by a cloned repository) can never be launched.
 */
const OPENABLE_EXTENSIONS: ReadonlySet<string> = new Set(Object.values(EXTENSION_BY_MEDIA_TYPE));

/** The renderer-facing form of a stored artifact: a project-relative path and plain facts. */
export function toArtifactDto(project: Project, ref: ArtifactRef, forTask: string): ArtifactDto {
  const path = toProjectRelative(project, fileURLToPath(ref.uri));
  return {
    taskId: forTask,
    path,
    name: path.split('/').pop() ?? path,
    mediaType: ref.mediaType ?? 'application/octet-stream',
    sizeBytes: ref.sizeBytes ?? 0,
    draft: ref.draft === true,
  };
}

/** Directory segments (below the first root) where this project's artifacts live (ADR-013). */
function artifactSegments(project: Project): string[] {
  const configured = project.artifactsDirectory;
  if (configured === undefined) return ['.nexar', 'artifacts'];
  return configured.split(/[\\/]/).filter((s) => s !== '' && s !== '.');
}

/** The canonical artifacts directory, or undefined when nothing was ever stored. */
async function artifactsDirectory(project: Project): Promise<string | undefined> {
  const root = project.realRoots[0];
  if (root === undefined) return undefined;
  try {
    return await resolveContainedPath(join(root, ...artifactSegments(project)), project.realRoots);
  } catch {
    return undefined;
  }
}

async function listArtifacts(ctx: CallContext, id: string): Promise<readonly ArtifactDto[]> {
  const project = requireProject(ctx, id);
  const directory = await artifactsDirectory(project);
  if (directory === undefined) return [];
  const store = new LocalArtifactStore({
    projects: ctx.deps.engine.composition().runtime.projects,
  });

  const tasks: { name: string; mtime: number }[] = [];
  for (const dirent of await readdir(directory, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const info = await stat(join(directory, dirent.name)).catch(() => undefined);
    if (info !== undefined) tasks.push({ name: dirent.name, mtime: info.mtimeMs });
  }
  tasks.sort((a, b) => b.mtime - a.mtime);

  const result: ArtifactDto[] = [];
  for (const task of tasks.slice(0, MAX_TASK_DIRECTORIES)) {
    try {
      const refs = await store.list({ projectId: asProjectId(id), taskId: taskId(task.name) });
      for (const ref of refs) result.push(toArtifactDto(project, ref, task.name));
    } catch {
      // A task directory that cannot be listed is skipped, not fatal.
    }
  }
  return result;
}

/** Only stored artifacts may be handed to the OS default handler, never arbitrary project files. */
async function artifactFile(ctx: CallContext, id: string, path: string): Promise<string> {
  const project = requireProject(ctx, id);
  const file = await resolveProjectPath(project, path);
  const directory = await artifactsDirectory(project);
  if (directory === undefined || !isWithin(directory, file)) throw outsideBoundary();
  if (!OPENABLE_EXTENSIONS.has(extname(file).toLowerCase())) {
    throw new NexarError('POLICY_REJECTED', 'Only Nexar artifact files can be opened');
  }
  if (!(await stat(file)).isFile()) {
    throw new NexarError('VALIDATION_ERROR', 'The path is not a file');
  }
  return file;
}

const ArtifactTarget = z.strictObject({
  projectId: ProjectIdSchema,
  path: RelativePathSchema.min(1),
});

export const artifactChannels: Readonly<Record<string, ChannelDefinition>> = {
  [CHANNELS.artifactsList]: defineChannel(
    z.strictObject({ projectId: ProjectIdSchema }),
    (a, ctx) => listArtifacts(ctx, a.projectId),
  ),
  [CHANNELS.artifactsOpen]: defineChannel(ArtifactTarget, async (a, ctx) => {
    const failure = await ctx.deps.shell.openPath(await artifactFile(ctx, a.projectId, a.path));
    if (failure !== '') {
      throw new NexarError('INTEGRATION_UNAVAILABLE', 'The file could not be opened');
    }
    return null;
  }),
  [CHANNELS.artifactsReveal]: defineChannel(ArtifactTarget, async (a, ctx) => {
    ctx.deps.shell.showItemInFolder(await artifactFile(ctx, a.projectId, a.path));
    return null;
  }),
};
