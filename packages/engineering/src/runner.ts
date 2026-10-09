import { randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApprovalGate } from '@nexar/approvals';
import type { ArtifactStore } from '@nexar/artifacts';
import {
  NexarError,
  projectId as toProjectId,
  type Logger,
  type ProcessLauncher,
  type TelemetrySink,
} from '@nexar/contracts';
import type { Nexar } from '@nexar/core';
import { resolveContainedPath, type ProjectRegistry } from '@nexar/projects';
import * as defaultWorktrees from '@nexar/worktrees';
import {
  EngineeringExecution,
  type EngineeringInput,
  type EngineeringOutcome,
  type EngineeringRunOptions,
  type EngineeringStrategist,
  type WorktreeOps,
} from './execution.js';
import type { LaneEngine } from './lane-engine.js';
import type { PlanCatalog } from './plan.js';
import { isEngineeringLineage, readEngineeringRecord } from './record.js';

export const MAX_GOAL_CHARS = 20_000;
/** Bound of the optional task title (same as the plane protocol's `run.title`). */
export const MAX_TITLE_CHARS = 200;
/** Bound of the optional required context (same as `@nexar/project-memory` and the plane protocol). */
export const MAX_REQUIRED_CONTEXT_CHARS = 16_000;
export const DEFAULT_PLAN_ID = 'implement-review';
const DEFAULT_APPROVAL_TTL_MS = 30 * 60 * 1000;

export interface EngineeringRunnerDependencies {
  readonly nexar: Nexar;
  readonly projects: ProjectRegistry;
  readonly plans: PlanCatalog;
  /** Must report `isolation: 'sandbox'`; read-write lanes, setup and gates refuse anything else. */
  readonly launcher: ProcessLauncher;
  /** In `deny-all` mode owner approval is impossible and tasks end `not-accepted`. */
  readonly approvals: ApprovalGate;
  readonly artifacts: ArtifactStore;
  readonly telemetry: TelemetrySink;
  readonly logger: Logger;
  readonly clock?: () => Date;
  readonly newId?: () => string;
  /** Records live at `<stateDir>/engineering/<taskId>/record.json`. */
  readonly stateDir: string;
  readonly worktreesDir?: string;
  readonly author: { readonly name: string; readonly email: string };
  readonly approvalTtlMs?: number;
  /** Test seam; defaults to `@nexar/worktrees`. */
  readonly worktrees?: WorktreeOps;
  /** Plans every lane's resource upfront (`strategy@1`); absent = lanes are routed one by one. */
  readonly strategist?: EngineeringStrategist;
  /** Gives write lanes an engine gateway session (ADR-027 section 9b); absent = lanes run as before. */
  readonly laneEngine?: LaneEngine;
}

/**
 * Turns one owner goal into: private worktree → lanes (each routed by the Resource Controller) →
 * sandboxed harvest → gates on a fresh clone → review on a different resource → owner approval →
 * a Nexar-made commit on `nexar/<taskId>`. It never pushes (ADR-019).
 */
export class EngineeringRunner {
  private readonly clock: () => Date;
  private readonly newId: () => string;
  private readonly worktrees: WorktreeOps;

  constructor(private readonly deps: EngineeringRunnerDependencies) {
    this.clock = deps.clock ?? (() => new Date());
    this.newId = deps.newId ?? (() => `eng-${randomBytes(6).toString('hex')}`);
    this.worktrees = deps.worktrees ?? defaultWorktrees;
  }

  /**
   * Invalid input, an unknown project or plan, and a launcher without sandbox isolation throw
   * (before anything is created). Once the task exists, every ending is an outcome and a record.
   */
  async run(
    input: EngineeringInput,
    options: EngineeringRunOptions = {},
  ): Promise<EngineeringOutcome> {
    const { goal } = input;
    if (typeof goal !== 'string' || goal.trim() === '' || goal.includes('\0')) {
      throw new NexarError('VALIDATION_ERROR', 'The goal must be a non-empty string');
    }
    if (goal.length > MAX_GOAL_CHARS) {
      throw new NexarError(
        'VALIDATION_ERROR',
        `The goal is longer than ${String(MAX_GOAL_CHARS)} characters`,
      );
    }
    const { title } = input;
    if (
      title !== undefined &&
      (typeof title !== 'string' ||
        title.trim() === '' ||
        title.includes('\0') ||
        title.length > MAX_TITLE_CHARS)
    ) {
      throw new NexarError('VALIDATION_ERROR', 'The title is not valid');
    }
    const { requiredContext } = input;
    if (
      requiredContext !== undefined &&
      (typeof requiredContext !== 'string' ||
        requiredContext.trim() === '' ||
        requiredContext.includes('\0') ||
        requiredContext.length > MAX_REQUIRED_CONTEXT_CHARS)
    ) {
      throw new NexarError('VALIDATION_ERROR', 'The required context is not valid');
    }
    if (input.lineage !== undefined && !isEngineeringLineage(input.lineage)) {
      throw new NexarError('VALIDATION_ERROR', 'The lineage is not valid');
    }
    const project = this.deps.projects.require(toProjectId(input.projectId));
    const settings = project.engineering;
    if (settings === undefined) {
      throw new NexarError('CONFIGURATION_ERROR', 'The project has no engineering settings');
    }
    const plan = this.deps.plans.require(input.planId ?? DEFAULT_PLAN_ID);
    if (this.deps.launcher.isolation !== 'sandbox') {
      throw new NexarError('POLICY_REJECTED', 'Engineering tasks require a sandboxing launcher');
    }
    const firstRoot = project.realRoots[0];
    if (firstRoot === undefined) {
      throw new NexarError('CONFIGURATION_ERROR', 'The project has no root');
    }
    // Only the canonical, contained path is passed on.
    const repository = await resolveContainedPath(settings.repository, project.realRoots, {
      base: firstRoot,
    });

    const execution = new EngineeringExecution(
      {
        nexar: this.deps.nexar,
        plan,
        launcher: this.deps.launcher,
        approvals: this.deps.approvals,
        artifacts: this.deps.artifacts,
        telemetry: this.deps.telemetry,
        logger: this.deps.logger,
        clock: this.clock,
        stateDir: this.deps.stateDir,
        worktreesDir: this.deps.worktreesDir,
        author: this.deps.author,
        approvalTtlMs: this.deps.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS,
        worktrees: this.worktrees,
        ...(this.deps.strategist === undefined ? {} : { strategist: this.deps.strategist }),
        ...(this.deps.laneEngine === undefined ? {} : { laneEngine: this.deps.laneEngine }),
      },
      {
        taskId: this.newId(),
        project,
        settings,
        repository,
        goal,
        ...(title === undefined ? {} : { title }),
        ...(requiredContext === undefined ? {} : { requiredContext }),
        baseBranch: input.baseBranch ?? settings.baseBranch,
        ...(input.lineage === undefined
          ? {}
          : {
              lineage: {
                sessionId: input.lineage.sessionId,
                turnId: input.lineage.turnId,
                correlationId: input.lineage.correlationId,
                depth: input.lineage.depth,
              },
            }),
      },
      options,
    );
    return execution.run();
  }

  /** Deletes a task's worktree directory (never the commit branch). Failed tasks keep it until then. */
  async cleanup(taskId: string): Promise<void> {
    const record = await readEngineeringRecord(this.deps.stateDir, taskId);
    if (record === undefined) throw new NexarError('VALIDATION_ERROR', 'Unknown engineering task');
    const configured = this.deps.worktreesDir ?? defaultWorktrees.defaultWorktreesDir();
    let baseDir: string;
    try {
      baseDir = await realpath(configured);
    } catch {
      return; // nothing was ever created
    }
    const taskDir = join(baseDir, record.projectId, record.taskId);
    await this.worktrees.removeTaskWorktree({
      projectId: record.projectId,
      taskId: record.taskId,
      taskDir,
      workPath: join(taskDir, 'work'),
      baseGitPath: join(taskDir, 'base.git'),
      baseCommit: record.baseCommit ?? '',
      baseBranch: record.baseBranch,
      baseDir,
    });
  }
}
