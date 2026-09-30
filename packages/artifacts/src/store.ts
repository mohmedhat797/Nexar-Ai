import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NexarError, type ArtifactRef, type ProjectId, type TaskId } from '@nexar/contracts';
import { isWithin, type Project, type ProjectRegistry } from '@nexar/projects';
import { sanitizeFilename, type ArtifactMediaType } from './sanitize.js';

export const DEFAULT_MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
const MAX_COLLISION_SUFFIX = 99;
const DEFAULT_DIRECTORY = ['.nexar', 'artifacts'] as const;
const DRAFTS = 'drafts';

export interface StoreArtifactInput {
  readonly projectId: ProjectId;
  readonly taskId: TaskId;
  /** Untrusted: sanitized, and its extension is forced to match `mediaType`. */
  readonly filename: string;
  readonly content: string | Uint8Array;
  readonly mediaType: ArtifactMediaType;
  readonly label?: string;
  readonly draft?: boolean;
}

export interface ArtifactStore {
  store(input: StoreArtifactInput, signal?: AbortSignal): Promise<ArtifactRef>;
  list(query: { readonly projectId: ProjectId; readonly taskId: TaskId }): Promise<ArtifactRef[]>;
}

export interface LocalArtifactStoreOptions {
  readonly projects: ProjectRegistry;
  /** Default 5 MiB. */
  readonly maxBytes?: number;
}

const MEDIA_TYPE_BY_EXTENSION: Readonly<Record<string, ArtifactMediaType>> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.csv': 'text/csv',
};

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

function escapeError(): NexarError {
  return new NexarError('POLICY_REJECTED', 'Artifact location is outside the project boundary', {
    details: { reason: 'OUTSIDE_BOUNDARY' },
  });
}

/** The task id as one directory name: `[A-Za-z0-9._-]` only, never `.`/`..`. */
function taskDirectoryName(id: TaskId): string {
  const name = String(id)
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 128);
  return name === '' ? 'task' : name;
}

function stemAndExtension(name: string): { stem: string; ext: string } {
  const ext = extname(name);
  return { stem: name.slice(0, name.length - ext.length), ext };
}

/**
 * Writes artifacts under `<project root>/.nexar/artifacts/<task>/` (or the project's
 * `artifactsDirectory`). Never overwrites, never follows a symlink out of the project.
 */
export class LocalArtifactStore implements ArtifactStore {
  private readonly projects: ProjectRegistry;
  private readonly maxBytes: number;

  constructor(options: LocalArtifactStoreOptions) {
    this.projects = options.projects;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  }

  /** Directory segments below the project's first root, and whether it is the default layout. */
  private layout(project: Project): { segments: string[]; isDefault: boolean } {
    const configured = project.artifactsDirectory;
    if (configured === undefined) return { segments: [...DEFAULT_DIRECTORY], isDefault: true };
    const normalized = normalize(configured);
    const segments = normalized.split(/[\\/]/).filter((s) => s !== '' && s !== '.');
    if (isAbsolute(configured) || segments.length === 0 || segments.includes('..')) {
      throw new NexarError(
        'CONFIGURATION_ERROR',
        `Project "${project.id}" artifactsDirectory must be a relative path inside its root`,
      );
    }
    return { segments, isDefault: false };
  }

  private target(project: Project, taskId: TaskId, draft: boolean) {
    const { segments, isDefault } = this.layout(project);
    const root = project.realRoots[0];
    if (root === undefined) {
      throw new NexarError('CONFIGURATION_ERROR', `Project "${project.id}" has no root`);
    }
    return {
      root,
      isDefault,
      segments: [...segments, taskDirectoryName(taskId), ...(draft ? [DRAFTS] : [])],
    };
  }

  /**
   * Creates the directories one level at a time and canonicalizes after each, so a symlink swapped
   * into any level is caught before anything is created beyond it.
   */
  private async ensureDirectory(
    root: string,
    segments: readonly string[],
    gitignore: boolean,
  ): Promise<string> {
    let current = root;
    for (const [index, segment] of segments.entries()) {
      const next = join(current, segment);
      try {
        await mkdir(next, { mode: 0o700 });
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error;
      }
      current = await realpath(next);
      if (!isWithin(root, current)) throw escapeError();
      // Keep artifacts out of source control even when .nexar/ already existed (telemetry, runtimes).
      if (gitignore && index === 0) {
        await writeFile(join(current, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 }).catch(
          (error: unknown) => {
            if (!isErrno(error, 'EEXIST')) throw error;
          },
        );
      }
    }
    return current;
  }

  async store(input: StoreArtifactInput, signal?: AbortSignal): Promise<ArtifactRef> {
    const bytes =
      typeof input.content === 'string' ? Buffer.from(input.content, 'utf8') : input.content;
    if (bytes.byteLength > this.maxBytes) {
      throw new NexarError(
        'VALIDATION_ERROR',
        `Artifact exceeds the maximum size of ${String(this.maxBytes)} bytes`,
      );
    }
    const project = this.projects.require(input.projectId);
    const draft = input.draft === true;
    const { root, segments, isDefault } = this.target(project, input.taskId, draft);
    if (signal?.aborted === true) {
      throw new NexarError('EXECUTION_CANCELLED', 'Artifact storage was cancelled');
    }

    const directory = await this.ensureDirectory(root, segments, isDefault);
    const { stem, ext } = stemAndExtension(sanitizeFilename(input.filename, input.mediaType));

    for (let attempt = 1; attempt <= MAX_COLLISION_SUFFIX; attempt++) {
      const name = attempt === 1 ? `${stem}${ext}` : `${stem}-${String(attempt)}${ext}`;
      const path = join(directory, name);
      let handle;
      try {
        // O_EXCL: refuses an existing file and an existing symlink alike, so nothing is overwritten.
        handle = await open(path, 'wx', 0o600);
      } catch (error) {
        if (isErrno(error, 'EEXIST')) continue;
        throw error;
      }
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(path).catch(() => undefined);
        throw error;
      }
      await handle.close();
      return {
        uri: pathToFileURL(path).href,
        label: input.label ?? relative(root, path),
        mediaType: input.mediaType,
        sizeBytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        draft,
      };
    }
    throw new NexarError('VALIDATION_ERROR', 'Too many artifacts with this name');
  }

  async list(query: {
    readonly projectId: ProjectId;
    readonly taskId: TaskId;
  }): Promise<ArtifactRef[]> {
    const project = this.projects.require(query.projectId);
    const refs: ArtifactRef[] = [];
    for (const draft of [false, true]) {
      const { root, segments } = this.target(project, query.taskId, draft);
      let directory: string;
      try {
        directory = await realpath(join(root, ...segments));
      } catch (error) {
        if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) continue;
        throw error;
      }
      if (!isWithin(root, directory)) throw escapeError();
      for (const entry of await readdir(directory)) {
        const path = join(directory, entry);
        const ref = await this.describe(root, path, draft);
        if (ref !== undefined) refs.push(ref);
      }
    }
    return refs.sort((a, b) => ((a.label ?? '') < (b.label ?? '') ? -1 : 1));
  }

  /** A ref for a regular file only; symlinks, directories and anything unreadable are skipped. */
  private async describe(
    root: string,
    path: string,
    draft: boolean,
  ): Promise<ArtifactRef | undefined> {
    let info;
    try {
      info = await lstat(path);
    } catch {
      return undefined;
    }
    if (!info.isFile()) return undefined;
    const mediaType = MEDIA_TYPE_BY_EXTENSION[extname(path).toLowerCase()];
    let sha256: string | undefined;
    if (info.size <= this.maxBytes) {
      try {
        // O_NOFOLLOW closes the window between lstat and open.
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          sha256 = createHash('sha256')
            .update(await handle.readFile())
            .digest('hex');
        } finally {
          await handle.close();
        }
      } catch {
        return undefined;
      }
    }
    return {
      uri: pathToFileURL(path).href,
      label: relative(root, path),
      ...(mediaType === undefined ? {} : { mediaType }),
      sizeBytes: info.size,
      ...(sha256 === undefined ? {} : { sha256 }),
      draft,
    };
  }
}
