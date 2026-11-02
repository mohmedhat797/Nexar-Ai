import { isAbsolute, relative, sep } from 'node:path';
import { z } from 'zod';
import { NexarError, isNexarError, projectId, type Logger, type ProjectId } from '@nexar/contracts';
import { resolveContainedPath, type Project } from '@nexar/projects';
import type { OperatingService } from '@nexar/operating';
import type { FileProjectMemoryStore } from '@nexar/project-memory';
import type { FileSessionStore } from '@nexar/sessions';
import type { AppInfo, SessionEvent, TaskEvent } from '../shared/api.js';
import type { ConfigStore } from './config-store.js';
import type { EngineHost } from './engine-host.js';
import type { CodePlane } from './code-plane.js';
import type { CoworkLane } from './dsh-cowork.js';
import type { SettingsStore } from './settings-store.js';
import type { ProviderService } from './providers.js';
import type { SubscriptionService } from './subscriptions.js';
import type { ChatGptPlanService } from './chatgpt-plan.js';
import type { LocalEndpointService } from './local-endpoints.js';
import type { ProviderInventoryService } from './provider-inventory.js';
import type { CodexLoginService } from './codex-login.js';
import type { ConnectionManager } from './connection-manager.js';

/** The slice of Electron's `dialog` the bridge uses; tests substitute a fake. */
export interface DialogPort {
  showOpenDialog(options: {
    properties: ('openDirectory' | 'createDirectory')[];
  }): Promise<{ readonly canceled: boolean; readonly filePaths: readonly string[] }>;
}

/** The slice of Electron's `shell` the bridge uses; tests substitute a fake. */
export interface ShellPort {
  /** Resolves to an error string, or `''` on success (Electron's contract). */
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void;
}

/**
 * What the session channels need from the session store; tests inject a store on a temp directory.
 * Only the lease holder can mutate (ADR-024 section 6).
 */
export type SessionService = Pick<
  FileSessionStore,
  | 'list'
  | 'get'
  | 'create'
  | 'beginTurn'
  | 'linkTask'
  | 'updateTask'
  | 'linkArtifacts'
  | 'linkApprovals'
  | 'completeTurn'
  | 'resolveConfirmation'
  | 'setContext'
  | 'setMode'
  | 'rename'
>;

/** Owner-confirmed project memory (ADR-030 §7); writes need the sessions lease. */
export type ProjectMemoryService = Pick<FileProjectMemoryStore, 'list' | 'add' | 'remove'>;

export interface BridgeDeps {
  readonly engine: EngineHost;
  readonly config: ConfigStore;
  readonly settings: SettingsStore;
  readonly providers?: ProviderService;
  readonly subscriptions?: SubscriptionService;
  readonly chatgptPlan?: ChatGptPlanService;
  readonly localEndpoints?: LocalEndpointService;
  readonly providerInventory?: ProviderInventoryService;
  readonly connectionManager?: ConnectionManager;
  readonly codexLogin?: CodexLoginService;
  /** The WSL2 engineering-plane bridge (ADR-025); absent in tests that do not need it. */
  readonly codePlane?: CodePlane;
  /** The Cowork lane on DeepSeek Harness (ADR-030); absent in tests that do not need it. */
  readonly cowork?: CoworkLane;
  readonly logger: Logger;
  readonly dialog: DialogPort;
  readonly shell: ShellPort;
  readonly appInfo: AppInfo;
  /** Names the decider on approvals, e.g. `desktop:alice`. */
  readonly decider: string;
  /** `undefined` when another Nexar process holds the sessions lease: every session channel fails. */
  readonly sessions: SessionService | undefined;
  /** Project memory behind the `projectMemory:*` channels and every turn's required context. */
  readonly projectMemory?: ProjectMemoryService | undefined;
  /** Pushes a session change to every live window (ids and short status lines only). */
  readonly broadcastSession: (event: SessionEvent) => void;
}

/** Running tasks by renderer-chosen request id, so they can be cancelled. */
export class JobRegistry {
  private static readonly MAX_JOBS = 16;
  private readonly jobs = new Map<string, AbortController>();

  begin(requestId: string): AbortController {
    if (this.jobs.has(requestId)) {
      throw new NexarError('VALIDATION_ERROR', 'A task with this request id is already running');
    }
    if (this.jobs.size >= JobRegistry.MAX_JOBS) {
      throw new NexarError(
        'VALIDATION_ERROR',
        'Too many tasks are running; wait for one to finish',
      );
    }
    const controller = new AbortController();
    this.jobs.set(requestId, controller);
    return controller;
  }

  end(requestId: string): void {
    this.jobs.delete(requestId);
  }

  abort(requestId: string): boolean {
    const controller = this.jobs.get(requestId);
    if (controller === undefined) return false;
    controller.abort(new NexarError('EXECUTION_CANCELLED', 'The task was cancelled'));
    return true;
  }
}

/** What a handler gets besides its validated arguments. */
export interface CallContext {
  readonly deps: BridgeDeps;
  readonly jobs: JobRegistry;
  /** Sends a progress event to the window that made the call. */
  readonly emit: (event: TaskEvent) => void;
  /** The turn pipeline over `deps.sessions`; `undefined` when another process holds the lease. */
  readonly operating: OperatingService | undefined;
}

export interface ChannelDefinition {
  readonly schema: z.ZodType;
  readonly handler: (args: never, ctx: CallContext) => Promise<unknown>;
}

/** Pairs a strict schema with a handler whose argument type is the schema's output. */
export function defineChannel<S extends z.ZodType>(
  schema: S,
  handler: (args: z.output<S>, ctx: CallContext) => Promise<unknown>,
): ChannelDefinition {
  return { schema, handler };
}

/** The only shape an error may take on its way to the renderer, a log or a stored turn. */
export function safeError(error: unknown): { readonly code: string; readonly message: string } {
  if (isNexarError(error)) return { code: error.code, message: error.message };
  return { code: 'INTERNAL_ERROR', message: 'Internal error' };
}

// --- shared argument schemas (all strict; length-bounded) -------------------------------------

export const NoArgs = z.strictObject({});
export const ProjectIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/);
export const RequestIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
export const TaskKindSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/);
export const ResourceIdListSchema = z
  .array(z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/))
  .max(32);
const NoNul = (s: string): boolean => !s.includes('\0');
/** A project-relative path: validated for shape here, then contained by `resolveContainedPath`. */
export const RelativePathSchema = z.string().max(1024).refine(NoNul, 'must not contain NUL');

export function requireProject(ctx: CallContext, id: string): Project {
  return ctx.deps.engine.composition().runtime.projects.require(projectId(id));
}

export function outsideBoundary(): NexarError {
  return new NexarError('POLICY_REJECTED', 'Path is outside the project boundary', {
    details: { reason: 'OUTSIDE_BOUNDARY' },
  });
}

/**
 * A project-relative path from the renderer, resolved to its canonical absolute path. Absolute
 * paths and `..` segments are refused up front; symlinks that leave the project fail the
 * containment check. The rejected input is never echoed. Callers pass the result onward.
 */
export async function resolveProjectPath(project: Project, relativePath: string): Promise<string> {
  const root = project.realRoots[0];
  if (root === undefined) throw outsideBoundary();
  if (
    isAbsolute(relativePath) ||
    /^[A-Za-z]:/.test(relativePath) ||
    relativePath.startsWith('/') ||
    relativePath.startsWith('\\') ||
    relativePath.split(/[\\/]/).includes('..')
  ) {
    throw outsideBoundary();
  }
  return resolveContainedPath(relativePath === '' ? '.' : relativePath, project.realRoots, {
    base: root,
  });
}

/** `docs/a.md` style path (always `/`) of a canonical path below the project's first root. */
export function toProjectRelative(project: Project, absolute: string): string {
  const root = project.realRoots[0] ?? '';
  return relative(root, absolute).split(sep).join('/');
}

export function asProjectId(id: string): ProjectId {
  return projectId(id);
}
