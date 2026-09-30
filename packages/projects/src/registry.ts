import { readdir, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NexarError, isNexarError, type ArtifactRef, type ProjectId } from '@nexar/contracts';
import {
  OUTSIDE_BOUNDARY_REASON,
  canonicalRoots,
  isWithin,
  resolveContainedPath,
} from './path-policy.js';
import type { Project, ProjectDefinition } from './project.js';

/** Upper bound on files a single document set may expand to. */
export const MAX_DOCUMENT_SET_FILES = 500;

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.json': 'application/json',
  '.csv': 'text/csv',
};

function configError(message: string): NexarError {
  return new NexarError('CONFIGURATION_ERROR', message);
}

async function buildProject(definition: ProjectDefinition): Promise<Project> {
  if (definition.roots.length === 0) {
    throw configError(`Project "${definition.id}" needs at least one root`);
  }
  const realRoots = await canonicalRoots(definition.roots);
  const workingDirectories = definition.workingDirectories ?? definition.roots;
  if (workingDirectories.length === 0) {
    throw configError(`Project "${definition.id}" needs at least one working directory`);
  }
  const realWorkingDirectories = await canonicalRoots(workingDirectories);
  realWorkingDirectories.forEach((dir, i) => {
    if (!realRoots.some((root) => isWithin(root, dir))) {
      throw configError(
        `Project "${definition.id}" working directory "${workingDirectories[i] ?? ''}" is outside its roots`,
      );
    }
  });
  return { ...definition, realRoots, realWorkingDirectories };
}

/** Immutable set of projects with canonical directories; the source of truth for path policy. */
export class ProjectRegistry {
  private constructor(private readonly projects: ReadonlyMap<ProjectId, Project>) {}

  static empty(): ProjectRegistry {
    return new ProjectRegistry(new Map());
  }

  /** Canonicalizes every root and working directory; fails closed on any problem. */
  static async create(definitions: readonly ProjectDefinition[]): Promise<ProjectRegistry> {
    const projects = new Map<ProjectId, Project>();
    for (const definition of definitions) {
      if (projects.has(definition.id)) {
        throw configError(`Duplicate project id "${definition.id}"`);
      }
      projects.set(definition.id, await buildProject(definition));
    }
    return new ProjectRegistry(projects);
  }

  get(id: ProjectId): Project | undefined {
    return this.projects.get(id);
  }

  /** Unknown ids are rejected without revealing which ids exist. */
  require(id: ProjectId): Project {
    const project = this.projects.get(id);
    if (project === undefined) throw new NexarError('POLICY_REJECTED', 'Unknown project');
    return project;
  }

  list(): readonly Project[] {
    return [...this.projects.values()];
  }

  /**
   * The canonical directory a task may run in. `requested` (absolute, or relative to the project's
   * first working directory) must resolve, through symlinks, to a directory inside a working
   * directory. Callers must use the returned path, not `requested`.
   */
  async resolveWorkingDirectory(project: Project, requested?: string): Promise<string> {
    const first = project.realWorkingDirectories[0];
    if (first === undefined) throw configError(`Project "${project.id}" has no working directory`);
    if (requested === undefined) return first;
    const real = await resolveContainedPath(requested, project.realWorkingDirectories, {
      base: first,
    });
    if (!(await stat(real)).isDirectory()) {
      throw new NexarError('POLICY_REJECTED', 'Path is not a directory', {
        details: { reason: 'NOT_A_DIRECTORY' },
      });
    }
    return real;
  }

  /** Expands a document set to file references (never contents), sorted by uri. */
  async resolveDocumentSet(project: Project, name: string): Promise<ArtifactRef[]> {
    const sets = project.documentSets ?? {};
    const entries = Object.hasOwn(sets, name) ? sets[name] : undefined;
    if (entries === undefined) {
      throw new NexarError('VALIDATION_ERROR', `Unknown document set "${name}"`);
    }
    const files = new Set<string>();
    const add = (file: string): void => {
      files.add(file);
      if (files.size > MAX_DOCUMENT_SET_FILES) {
        throw new NexarError(
          'VALIDATION_ERROR',
          `Document set "${name}" exceeds ${String(MAX_DOCUMENT_SET_FILES)} files`,
        );
      }
    };

    const walk = async (directory: string): Promise<void> => {
      for (const dirent of await readdir(directory, { withFileTypes: true })) {
        if (dirent.name.startsWith('.')) continue;
        // Re-checked per entry: a symlink leading out of the root is rejected, not skipped.
        const real = await resolveContainedPath(join(directory, dirent.name), project.realRoots);
        const info = await stat(real);
        if (info.isDirectory()) {
          if (!dirent.isSymbolicLink()) await walk(real);
        } else if (info.isFile()) {
          add(real);
        }
      }
    };

    for (const [index, entry] of entries.entries()) {
      let real: string;
      try {
        real = await resolveContainedPath(entry, project.realRoots);
      } catch (error) {
        const outside =
          isNexarError(error) &&
          (error.details as { reason?: unknown } | undefined)?.reason === OUTSIDE_BOUNDARY_REASON;
        if (outside || !isNexarError(error)) throw error;
        throw configError(
          `Document set "${name}" entry ${String(index)} does not exist or is not accessible`,
        );
      }
      const info = await stat(real);
      if (info.isDirectory()) await walk(real);
      else if (info.isFile()) add(real);
      else {
        throw configError(
          `Document set "${name}" entry ${String(index)} is not a file or directory`,
        );
      }
    }

    return [...files]
      .map((file): ArtifactRef => {
        const root = project.realRoots.find((r) => isWithin(r, file)) ?? '';
        const mediaType = MEDIA_TYPES[extname(file).toLowerCase()];
        return {
          uri: pathToFileURL(file).href,
          label: relative(root, file),
          ...(mediaType === undefined ? {} : { mediaType }),
        };
      })
      .sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
  }
}
