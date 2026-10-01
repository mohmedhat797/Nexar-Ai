import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { NexarError } from '@nexar/contracts';
import { resolveContainedPath, type Project } from '@nexar/projects';
import type { FileEntryDto, FileListing, FilePreview, ProjectDto } from '../shared/api.js';
import { CHANNELS } from '../shared/channels.js';
import {
  NoArgs,
  ProjectIdSchema,
  RelativePathSchema,
  defineChannel,
  requireProject,
  resolveProjectPath,
  toProjectRelative,
  type CallContext,
  type ChannelDefinition,
} from './channel.js';

export const MAX_LISTED_ENTRIES = 500;
export const MAX_PREVIEW_BYTES = 256 * 1024;
const HIDDEN_ENTRIES: ReadonlySet<string> = new Set(['.git', 'node_modules']);

function toDto(project: Project): ProjectDto {
  return { id: project.id, name: project.displayName, root: project.realRoots[0] ?? '' };
}

/** A config-safe project id (`^[a-z0-9][a-z0-9._:-]*$`) from a folder name, unique among `taken`. */
export function slugForFolder(folder: string, taken: ReadonlySet<string>): string {
  const base =
    folder
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[^a-z0-9]+/, '')
      .replace(/-+$/, '')
      .slice(0, 48) || 'project';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${String(n)}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function listProjects(ctx: CallContext): Promise<readonly ProjectDto[]> {
  return Promise.resolve(ctx.deps.engine.composition().runtime.projects.list().map(toDto));
}

/** The folder dialog is opened here, in the main process: the renderer never names a path. */
async function addProject(ctx: CallContext): Promise<ProjectDto | null> {
  const { dialog, config, engine } = ctx.deps;
  const picked = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  const first = picked.filePaths[0];
  if (picked.canceled || typeof first !== 'string' || first === '') return null;

  let root: string;
  try {
    root = await realpath(first);
    if (!(await stat(root)).isDirectory()) throw new Error('not a directory');
  } catch {
    // No path in the message or cause.
    throw new NexarError('VALIDATION_ERROR', 'The selected folder is not accessible');
  }

  const previousText = await config.readText();
  const { project, added } = await config.update((raw) => {
    const projects = Array.isArray(raw['projects']) ? (raw['projects'] as unknown[]) : [];
    const entries = projects.filter(
      (p): p is { id: string; displayName: string; roots: string[] } =>
        typeof p === 'object' && p !== null,
    );
    const existing = entries.find((p) => p.roots[0] === root);
    if (existing !== undefined) {
      return {
        added: false,
        project: { id: existing.id, name: existing.displayName, root },
      };
    }
    const id = slugForFolder(basename(root), new Set(entries.map((p) => p.id)));
    const name = basename(root) || 'Project';
    raw['projects'] = [...projects, { id, displayName: name, roots: [root] }];
    return { added: true, project: { id, name, root } };
  });
  if (added) {
    try {
      await engine.reload();
    } catch (error) {
      // A project that does not load must not leave the app unable to start.
      await config.restoreText(previousText);
      await engine.reload().catch(() => undefined);
      throw error;
    }
  }
  return project;
}

async function removeProject(ctx: CallContext, id: string): Promise<{ removed: boolean }> {
  const { config, engine } = ctx.deps;
  const previousText = await config.readText();
  const removed = await config.update((raw) => {
    const projects = Array.isArray(raw['projects']) ? (raw['projects'] as unknown[]) : [];
    const kept = projects.filter(
      (p) => !(typeof p === 'object' && p !== null && (p as { id?: unknown }).id === id),
    );
    raw['projects'] = kept;
    return kept.length !== projects.length;
  });
  if (removed) {
    try {
      await engine.reload();
    } catch (error) {
      await config.restoreText(previousText);
      await engine.reload().catch(() => undefined);
      throw error;
    }
  }
  return { removed };
}

async function listFiles(ctx: CallContext, projectId: string, dir: string): Promise<FileListing> {
  const project = requireProject(ctx, projectId);
  const directory = await resolveProjectPath(project, dir);
  if (!(await stat(directory)).isDirectory()) {
    throw new NexarError('VALIDATION_ERROR', 'The path is not a directory');
  }
  const found: { name: string; kind: 'dir' | 'file'; path: string }[] = [];
  for (const dirent of await readdir(directory, { withFileTypes: true })) {
    if (HIDDEN_ENTRIES.has(dirent.name)) continue;
    let path = join(directory, dirent.name);
    let isDirectory = dirent.isDirectory();
    let isFile = dirent.isFile();
    if (dirent.isSymbolicLink()) {
      // A link is shown only when its target is inside the project.
      try {
        path = await resolveContainedPath(path, project.realRoots);
        const info = await stat(path);
        isDirectory = info.isDirectory();
        isFile = info.isFile();
      } catch {
        continue;
      }
    }
    if (isDirectory) found.push({ name: dirent.name, kind: 'dir', path });
    else if (isFile) found.push({ name: dirent.name, kind: 'file', path });
  }
  found.sort((a, b) =>
    a.kind !== b.kind
      ? a.kind === 'dir'
        ? -1
        : 1
      : a.name < b.name
        ? -1
        : a.name > b.name
          ? 1
          : 0,
  );
  const shown = found.slice(0, MAX_LISTED_ENTRIES);
  const entries: FileEntryDto[] = [];
  for (const entry of shown) {
    const size = entry.kind === 'file' ? (await stat(entry.path).catch(() => undefined))?.size : 0;
    entries.push({ name: entry.name, kind: entry.kind, size: size ?? 0 });
  }
  const rel = toProjectRelative(project, directory);
  return { dir: rel === '.' ? '' : rel, entries, truncated: found.length > shown.length };
}

async function readPreview(
  ctx: CallContext,
  projectId: string,
  path: string,
): Promise<FilePreview> {
  const project = requireProject(ctx, projectId);
  const file = await resolveProjectPath(project, path);
  const info = await stat(file);
  if (!info.isFile()) throw new NexarError('VALIDATION_ERROR', 'The path is not a file');
  if (info.size > MAX_PREVIEW_BYTES) {
    throw new NexarError('VALIDATION_ERROR', 'The file is too large to preview (limit 256 KiB)');
  }
  const bytes = await readFile(file);
  if (bytes.byteLength > MAX_PREVIEW_BYTES || bytes.includes(0)) {
    throw new NexarError('VALIDATION_ERROR', 'The file is not UTF-8 text');
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), truncated: false };
  } catch {
    throw new NexarError('VALIDATION_ERROR', 'The file is not UTF-8 text');
  }
}

export const projectChannels: Readonly<Record<string, ChannelDefinition>> = {
  [CHANNELS.projectsList]: defineChannel(NoArgs, (_args, ctx) => listProjects(ctx)),
  [CHANNELS.projectsAdd]: defineChannel(NoArgs, (_args, ctx) => addProject(ctx)),
  [CHANNELS.projectsRemove]: defineChannel(z.strictObject({ id: ProjectIdSchema }), (a, ctx) =>
    removeProject(ctx, a.id),
  ),
  [CHANNELS.projectsFiles]: defineChannel(
    z.strictObject({ projectId: ProjectIdSchema, dir: RelativePathSchema.optional() }),
    (a, ctx) => listFiles(ctx, a.projectId, a.dir ?? ''),
  ),
  [CHANNELS.projectsReadFile]: defineChannel(
    z.strictObject({ projectId: ProjectIdSchema, path: RelativePathSchema.min(1) }),
    (a, ctx) => readPreview(ctx, a.projectId, a.path),
  ),
};
