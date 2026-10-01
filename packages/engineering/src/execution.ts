import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ArtifactStore } from '@nexar/artifacts';
import type { ApprovalGate, ApprovalGrant, OutwardAction } from '@nexar/approvals';
import {
  NexarError,
  isNexarError,
  resourceId as toResourceId,
  taskId as toTaskId,
  type EngineeringStep,
  type Logger,
  type ProcessLauncher,
  type ResourceId,
  type TelemetrySink,
  type UsageReport,
} from '@nexar/contracts';
import type { Nexar } from '@nexar/core';
import type { Project, ProjectEngineeringSettings } from '@nexar/projects';
import type {
  HarvestResult,
  TaskWorktree,
  commitPatch,
  createTaskWorktree,
  createVerificationWorkspace,
  harvestPatch,
  removeTaskWorktree,
} from '@nexar/worktrees';
import { networkFor, runCommand, type CommandRun } from './commands.js';
import type { LoadedPlan, PlanLane } from './plan.js';
import {
  writeEngineeringRecord,
  type CommandRecord,
  type EngineeringRecord,
  type EngineeringStatus,
  type LaneRecord,
  type PatchRecord,
  type ReviewRecord,
} from './record.js';
import { renderLaneTemplate, type LaneTemplate, type LaneValues } from './render.js';
import { parseReviewVerdict, type ReviewVerdict } from './verdict.js';

/** The `@nexar/worktrees` functions the runner uses; a seam so tests can observe or replace them. */
export interface WorktreeOps {
  readonly createTaskWorktree: typeof createTaskWorktree;
  readonly harvestPatch: typeof harvestPatch;
  readonly createVerificationWorkspace: typeof createVerificationWorkspace;
  readonly commitPatch: typeof commitPatch;
  readonly removeTaskWorktree: typeof removeTaskWorktree;
}

export interface EngineeringInput {
  readonly projectId: string;
  /** Owner text; untrusted data for every lane. At most 20 000 characters. */
  readonly goal: string;
  /** Default `implement-review`. */
  readonly planId?: string;
  /** Overrides the project's `baseBranch`. */
  readonly baseBranch?: string;
}

/**
 * Progress for a CLI. Scalars only (never the goal, prompts, diffs, output or paths). While
 * `awaiting-approval` the approval id is not known yet (the gate returns it after the decision);
 * the owner finds the pending request with `nexar approvals list`.
 */
export type EngineeringProgress =
  | {
      readonly type: 'step';
      readonly step: EngineeringStep;
      readonly detail: Readonly<Record<string, string | number | boolean>>;
    }
  | {
      readonly type: 'lane.started';
      readonly lane: string;
      readonly role: string;
      readonly round: number;
    }
  | {
      readonly type: 'awaiting-approval';
      readonly taskId: string;
      readonly projectId: string;
      readonly branch: string;
      readonly baseCommit: string;
      readonly patchSha256: string;
      readonly files: number;
      readonly gatesPassed: number;
      readonly reviewVerdict: string;
      readonly ttlMs: number;
    };

export interface EngineeringRunOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: EngineeringProgress) => void;
}

export interface EngineeringOutcome {
  readonly taskId: string;
  readonly status: 'committed' | 'not-accepted' | 'failed' | 'cancelled';
  readonly reason?: string;
  /** Present only when the task was committed. */
  readonly branch?: string;
  readonly commit?: string;
  readonly recordPath: string;
}

export interface ExecutionDependencies {
  readonly nexar: Nexar;
  readonly plan: LoadedPlan;
  readonly launcher: ProcessLauncher;
  readonly approvals: ApprovalGate;
  readonly artifacts: ArtifactStore;
  readonly telemetry: TelemetrySink;
  readonly logger: Logger;
  readonly clock: () => Date;
  readonly stateDir: string;
  readonly worktreesDir: string | undefined;
  readonly author: { readonly name: string; readonly email: string };
  readonly approvalTtlMs: number;
  readonly worktrees: WorktreeOps;
}

export interface ExecutionTarget {
  readonly taskId: string;
  readonly project: Project;
  readonly settings: ProjectEngineeringSettings;
  /** Canonical, contained path of the owner's repository. */
  readonly repository: string;
  readonly goal: string;
  readonly baseBranch: string;
}

/** Ends the task with a status; thrown from anywhere in the flow and settled in one place. */
class TaskEnd extends Error {
  constructor(
    readonly status: 'failed' | 'not-accepted' | 'cancelled',
    readonly reason: string,
  ) {
    super(reason);
  }
}

interface LaneSpec {
  readonly id: string;
  readonly role: string;
  readonly access: 'read-only' | 'read-write';
  readonly taskKind: string;
  readonly capabilities: readonly string[];
  readonly system: string;
  readonly brief: LaneTemplate;
  readonly preferred?: readonly ResourceId[];
  readonly independentReviewer?: boolean;
}

interface LaneResult {
  readonly text: string;
  readonly resourceId: string;
  readonly reasonCodes: readonly string[];
}

interface CheckResult {
  readonly name: string;
  readonly phase: CommandRecord['phase'];
  readonly passed: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly tail: string;
}

const MAX_ARTIFACT_CHARS = 1024 * 1024;

const sha256 = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

/** First line of the goal as a safe commit subject (at most 72 characters). */
export function commitSubject(goal: string): string {
  const first = goal.split(/\r?\n/)[0] ?? '';
  const clean = first.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, 72).trim();
  return `nexar: ${clean === '' ? 'engineering task' : clean}`;
}

function exitText(run: { exitCode: number | null; timedOut: boolean }): string {
  return run.timedOut
    ? 'timed out'
    : run.exitCode === null
      ? 'no exit code'
      : `exit ${String(run.exitCode)}`;
}

/** One engineering task from worktree to commit. Created by `EngineeringRunner.run`. */
export class EngineeringExecution {
  private readonly lanes: LaneRecord[] = [];
  private readonly commands: CommandRecord[] = [];
  private readonly patches: PatchRecord[] = [];
  private readonly reviews: ReviewRecord[] = [];
  private readonly rwResources = new Set<ResourceId>();
  private readonly laneExecutions: { role: string; resourceId: string }[] = [];
  private readonly startedAt: string;
  private status: EngineeringStatus = 'running';
  private reason: string | undefined;
  private endedAt: string | undefined;
  private baseCommit: string | undefined;
  private round = 0;
  private approval: { id?: string; outcome: string } | undefined;
  private commit: string | undefined;
  private worktree: TaskWorktree | undefined;
  private planText: string | undefined;
  private readonly branch: string;

  constructor(
    private readonly deps: ExecutionDependencies,
    private readonly target: ExecutionTarget,
    private readonly options: EngineeringRunOptions,
  ) {
    this.startedAt = deps.clock().toISOString();
    this.branch = `nexar/${target.taskId}`;
  }

  async run(): Promise<EngineeringOutcome> {
    let recordPath = '';
    try {
      recordPath = await this.persist();
      await this.begin();
      await this.agentSetup();
      for (const lane of this.deps.plan.lanes) {
        if (lane.role === 'review') continue;
        const result = await this.runLane(this.spec(lane), this.work(), lane.access, {
          goal: this.target.goal,
          ...(this.planText === undefined ? {} : { plan: this.planText }),
          round: 0,
        });
        if (lane.role === 'architecture') this.planText = result.text;
      }
      const accepted = await this.verifyUntilReviewed();
      await this.accept(accepted);
    } catch (error) {
      this.settle(error);
    }
    this.endedAt = this.deps.clock().toISOString();
    if (this.status === 'running') this.status = 'failed';
    try {
      recordPath = await this.step('task.finished', {
        status: this.status,
        ...(this.reason === undefined ? {} : { reason: this.reason }),
        rounds: this.round,
      });
    } catch (error) {
      this.deps.logger.warn('engineering record could not be written', {
        taskId: this.target.taskId,
        error: isNexarError(error) ? error.code : 'UNKNOWN',
      });
    }
    return {
      taskId: this.target.taskId,
      status: this.status,
      ...(this.reason === undefined ? {} : { reason: this.reason }),
      ...(this.status === 'committed' && this.commit !== undefined
        ? { branch: this.branch, commit: this.commit }
        : {}),
      recordPath,
    };
  }

  // ---- settling, records and telemetry -------------------------------------------------------

  private settle(error: unknown): void {
    if (error instanceof TaskEnd) {
      this.status = error.status;
      this.reason = error.reason;
      return;
    }
    if (this.options.signal?.aborted === true) {
      this.status = 'cancelled';
      this.reason = 'cancelled';
      return;
    }
    const code = isNexarError(error) ? error.code : 'INTERNAL_ERROR';
    this.deps.logger.warn('engineering task failed', { taskId: this.target.taskId, code });
    this.status = 'failed';
    this.reason = `error.${code}`;
  }

  private snapshot(): EngineeringRecord {
    return {
      schemaVersion: 1,
      taskId: this.target.taskId,
      projectId: this.target.project.id,
      planId: this.deps.plan.id,
      status: this.status,
      ...(this.reason === undefined ? {} : { reason: this.reason }),
      startedAt: this.startedAt,
      ...(this.endedAt === undefined ? {} : { endedAt: this.endedAt }),
      baseBranch: this.target.baseBranch,
      ...(this.baseCommit === undefined ? {} : { baseCommit: this.baseCommit }),
      branch: this.branch,
      round: this.round,
      lanes: this.lanes,
      commands: this.commands,
      patches: this.patches,
      reviews: this.reviews,
      ...(this.approval === undefined ? {} : { approval: this.approval }),
      ...(this.commit === undefined ? {} : { commit: this.commit }),
    };
  }

  private persist(): Promise<string> {
    return writeEngineeringRecord(this.deps.stateDir, this.snapshot());
  }

  /** Persists the record, then emits `engineering.step` telemetry and progress. Returns the record path. */
  private async step(
    step: EngineeringStep,
    detail: Readonly<Record<string, string | number | boolean>>,
  ): Promise<string> {
    const path = await this.persist();
    try {
      await this.deps.telemetry.emit({
        type: 'engineering.step',
        at: this.deps.clock().toISOString(),
        engineeringTaskId: this.target.taskId,
        projectId: this.target.project.id,
        step,
        detail,
      });
    } catch (error) {
      this.deps.logger.warn('telemetry sink failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.progress({ type: 'step', step, detail });
    return path;
  }

  private progress(event: EngineeringProgress): void {
    try {
      this.options.onProgress?.(event);
    } catch {
      // A broken progress callback must not affect the task.
    }
  }

  private checkCancelled(): void {
    if (this.options.signal?.aborted === true) throw new TaskEnd('cancelled', 'cancelled');
  }

  private work(): string {
    if (this.worktree === undefined) throw new NexarError('INTERNAL_ERROR', 'No task worktree');
    return this.worktree.workPath;
  }

  private async storeArtifact(
    filename: string,
    content: string,
    mediaType: 'text/markdown' | 'text/plain' | 'application/json',
    label: string,
  ): Promise<string> {
    const ref = await this.deps.artifacts.store(
      {
        projectId: this.target.project.id,
        taskId: toTaskId(this.target.taskId),
        filename,
        content,
        mediaType,
        label,
      },
      this.options.signal,
    );
    return ref.sha256 ?? sha256(content);
  }

  // ---- stages --------------------------------------------------------------------------------

  private async begin(): Promise<void> {
    const { settings, project, taskId, repository, baseBranch } = this.target;
    this.worktree = await this.deps.worktrees.createTaskWorktree({
      repository,
      projectId: project.id,
      taskId,
      baseBranch,
      ...(this.deps.worktreesDir === undefined ? {} : { baseDir: this.deps.worktreesDir }),
    });
    this.baseCommit = this.worktree.baseCommit;
    this.deps.logger.info('engineering task started', { taskId, planId: this.deps.plan.id });
    await this.step('task.started', {
      planId: this.deps.plan.id,
      lanes: this.deps.plan.lanes.length,
      maxReworkRounds: settings.maxReworkRounds,
      baseCommit: this.worktree.baseCommit,
    });
  }

  private async agentSetup(): Promise<void> {
    for (const setup of this.target.settings.setup) {
      this.checkCancelled();
      const result = await this.check('agent-setup', setup, this.work(), 0);
      if (!result.passed) throw new TaskEnd('failed', 'setup.failed');
    }
  }

  private spec(lane: PlanLane): LaneSpec {
    const preferred = this.target.settings.lanePreferences[lane.role];
    return {
      id: lane.id,
      role: lane.role,
      access: lane.access,
      taskKind: lane.taskKind,
      capabilities: lane.capabilities,
      system: lane.system,
      brief: lane.brief,
      ...(preferred === undefined ? {} : { preferred }),
      ...(lane.role === 'review' ? { independentReviewer: true } : {}),
    };
  }

  private debuggingSpec(): LaneSpec {
    const first = this.deps.plan.lanes.find((l) => l.access === 'read-write') as PlanLane;
    const preferred = this.target.settings.lanePreferences.debugging;
    return {
      id: 'debugging',
      role: 'debugging',
      access: 'read-write',
      taskKind: first.taskKind,
      capabilities: first.capabilities,
      system: this.deps.plan.debugging.system,
      brief: this.deps.plan.debugging.brief,
      ...(preferred === undefined ? {} : { preferred }),
    };
  }

  /** Routes (through the Resource Controller) and runs one lane, then records it. */
  private async runLane(
    lane: LaneSpec,
    workspacePath: string,
    access: 'read-only' | 'read-write',
    values: LaneValues,
  ): Promise<LaneResult> {
    this.checkCancelled();
    const { nexar, launcher, clock } = this.deps;
    const round = values.round;
    this.progress({ type: 'lane.started', lane: lane.id, role: lane.role, round });
    const prompt = renderLaneTemplate(lane.brief, values);
    let current: { taskId: string; startedMs: number } | undefined;

    const attempt = async (excluded: readonly ResourceId[]) => {
      const task = nexar.createTask({
        kind: lane.taskKind,
        prompt,
        systemPrompt: lane.system,
        projectId: this.target.project.id,
        requirements: {
          capabilities: lane.capabilities,
          ...(lane.preferred === undefined ? {} : { preferredResourceIds: lane.preferred }),
          ...(excluded.length === 0 ? {} : { excludedResourceIds: excluded }),
        },
        metadata: { engineeringTaskId: this.target.taskId, lane: lane.id, round },
      });
      current = { taskId: task.id, startedMs: clock().getTime() };
      return nexar.run(task, {
        workspace: { path: workspacePath, access, launcher },
        timeoutMs: this.target.settings.laneTimeoutMs,
        ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
      });
    };

    const exclusions = lane.independentReviewer === true ? [...this.rwResources] : [];
    const extraReasons: string[] = [];
    try {
      let outcome;
      try {
        outcome = await attempt(exclusions);
      } catch (error) {
        const noOther =
          isNexarError(error) && error.code === 'NO_ELIGIBLE_RESOURCE' && exclusions.length > 0;
        if (!noOther) throw error;
        if (this.target.settings.reviewDiversity === 'required') {
          throw new TaskEnd('failed', 'review.no-independent-resource');
        }
        extraReasons.push('review.same-resource');
        outcome = await attempt([]);
      }
      const reasonCodes = [...outcome.record.routing.reasonCodes, ...extraReasons];
      const resourceId = outcome.record.resourceId;
      const text = outcome.result.text;
      const outputSha256 = await this.storeArtifact(
        `lane-${lane.id}-r${String(round)}.md`,
        text.slice(0, MAX_ARTIFACT_CHARS) || '(empty)',
        'text/markdown',
        `Lane ${lane.id} round ${String(round)}`,
      );
      this.recordLane({
        laneId: lane.id,
        role: lane.role,
        round,
        taskId: outcome.task.id,
        resourceId,
        reasonCodes,
        outcome: 'succeeded',
        usage: outcome.record.usage,
        latencyMs: outcome.record.latencyMs,
        outputSha256,
      });
      this.laneExecutions.push({ role: lane.role, resourceId });
      if (lane.access === 'read-write') this.rwResources.add(toResourceId(resourceId));
      await this.step('lane.completed', {
        lane: lane.id,
        role: lane.role,
        round,
        resourceId,
        outcome: 'succeeded',
        latencyMs: outcome.record.latencyMs,
        reasons: reasonCodes.join(','),
      });
      return { text, resourceId, reasonCodes };
    } catch (error) {
      if (error instanceof TaskEnd) throw error;
      const code = isNexarError(error) ? error.code : 'INTERNAL_ERROR';
      const aborted = this.options.signal?.aborted === true;
      const outcome: LaneRecord['outcome'] = aborted
        ? 'cancelled'
        : code === 'EXECUTION_TIMEOUT'
          ? 'timed-out'
          : 'failed';
      const started = current?.startedMs ?? clock().getTime();
      this.recordLane({
        laneId: lane.id,
        role: lane.role,
        round,
        taskId: current?.taskId ?? '',
        reasonCodes: extraReasons,
        outcome,
        errorCode: code,
        latencyMs: clock().getTime() - started,
      });
      await this.step('lane.completed', {
        lane: lane.id,
        role: lane.role,
        round,
        outcome,
        errorCode: code,
      });
      if (aborted) throw new TaskEnd('cancelled', 'cancelled');
      throw new TaskEnd('failed', `lane.${lane.id}.${code}`);
    }
  }

  private recordLane(lane: {
    laneId: string;
    role: string;
    round: number;
    taskId: string;
    resourceId?: string;
    reasonCodes: readonly string[];
    outcome: LaneRecord['outcome'];
    errorCode?: string;
    usage?: UsageReport;
    latencyMs: number;
    outputSha256?: string;
  }): void {
    this.lanes.push(lane);
  }

  /** Runs one setup step or gate, stores its output as an artifact and records the result. */
  private async check(
    phase: CommandRecord['phase'],
    command: {
      readonly name: string;
      readonly command: readonly string[];
      readonly timeoutMs: number;
    },
    workspace: string,
    round: number,
  ): Promise<CheckResult> {
    const { settings } = this.target;
    const started = this.deps.clock().getTime();
    const run: CommandRun = await runCommand({
      launcher: this.deps.launcher,
      workspace,
      access: 'read-write',
      argv: command.command,
      network: phase === 'gate' ? { mode: 'none' } : networkFor(settings.setupAllowHosts),
      timeoutMs: command.timeoutMs,
      ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
    });
    if (run.cancelled) throw new TaskEnd('cancelled', 'cancelled');
    const durationMs = this.deps.clock().getTime() - started;
    const label = phase === 'gate' ? 'gate' : 'setup';
    await this.storeArtifact(
      `${label}-${command.name}-r${String(round)}.log`,
      run.output.toString('utf8') || '(no output)',
      'text/plain',
      `${label} ${command.name} round ${String(round)}`,
    );
    const passed = run.exitCode === 0 && !run.timedOut;
    this.commands.push({
      phase,
      name: command.name,
      round,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      passed,
      durationMs,
      outputSha256: sha256(run.output),
      outputBytes: run.outputBytes,
    });
    await this.step('gate.completed', {
      phase,
      name: command.name,
      round,
      exitCode: run.exitCode ?? -1,
      timedOut: run.timedOut,
      passed,
      durationMs,
      outputSha256: sha256(run.output),
    });
    return {
      name: command.name,
      phase,
      passed,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      tail: run.tail.toString('utf8'),
    };
  }

  private async harvest(): Promise<HarvestResult> {
    this.checkCancelled();
    const { patchPolicy } = this.target.settings;
    const harvest = await this.deps.worktrees.harvestPatch(this.worktree as TaskWorktree, {
      launcher: this.deps.launcher,
      maxBytes: patchPolicy.maxBytes,
      policy: {
        denyGlobs: patchPolicy.denyGlobs,
        allowSymlinks: patchPolicy.allowSymlinks,
        allowModeChanges: patchPolicy.allowModeChanges,
        maxBytes: patchPolicy.maxBytes,
      },
      ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
    });
    const violations = harvest.validation.ok
      ? []
      : [...new Set(harvest.validation.violations.map((v) => v.rule))];
    this.patches.push({
      round: this.round,
      sha256: harvest.sha256,
      bytes: harvest.bytes,
      files: harvest.entries.length,
      valid: harvest.validation.ok,
      violations,
    });
    await this.step('patch.harvested', {
      round: this.round,
      sha256: harvest.sha256,
      bytes: harvest.bytes,
      files: harvest.entries.length,
      valid: harvest.validation.ok,
      violations: violations.join(','),
    });
    if (harvest.entries.length === 0) throw new TaskEnd('failed', 'patch.empty');
    if (!harvest.validation.ok) throw new TaskEnd('failed', 'patch.invalid');
    return harvest;
  }

  /** Harvest → gates on a fresh clone → review, reworking while rounds remain. */
  private async verifyUntilReviewed(): Promise<{
    harvest: HarvestResult;
    review: ReviewVerdict;
    reviewer: string;
    gatesPassed: number;
  }> {
    const { settings } = this.target;
    for (;;) {
      const harvest = await this.harvest();
      const workspace = await this.deps.worktrees.createVerificationWorkspace(
        this.worktree as TaskWorktree,
        harvest,
      );
      const results: CheckResult[] = [];
      for (const setup of settings.setup) {
        const result = await this.check('verify-setup', setup, workspace, this.round);
        results.push(result);
        if (!result.passed) break;
      }
      if (results.every((r) => r.passed)) {
        for (const gate of settings.gates) {
          results.push(await this.check('gate', gate, workspace, this.round));
        }
      }
      const failed = results.filter((r) => !r.passed);
      if (failed.length > 0) {
        if (this.round >= settings.maxReworkRounds) throw new TaskEnd('failed', 'gates.failed');
        await this.rework(
          failed
            .map(
              (r) =>
                `${r.phase === 'gate' ? 'Gate' : 'Setup'} "${r.name}" failed (${exitText(r)}). Last output:\n${r.tail}`,
            )
            .join('\n\n'),
        );
        continue;
      }

      const gates = results.filter((r) => r.phase === 'gate');
      const patchText = await readFile(harvest.patchPath, 'utf8');
      const lane = this.deps.plan.lanes.find((l) => l.role === 'review') as PlanLane;
      const reviewed = await this.runLane(this.spec(lane), workspace, 'read-only', {
        goal: this.target.goal,
        ...(this.planText === undefined ? {} : { plan: this.planText }),
        patch: patchText,
        gates:
          gates.length === 0
            ? '(no gates configured)'
            : gates.map((g) => `- ${g.name}: passed (${exitText(g)})`).join('\n'),
        round: this.round,
      });
      const review = parseReviewVerdict(reviewed.text);
      const counts = { blocker: 0, major: 0, minor: 0, nit: 0 };
      for (const finding of review.findings) counts[finding.severity] += 1;
      const outputSha256 = await this.storeArtifact(
        `review-r${String(this.round)}.json`,
        JSON.stringify(review, null, 2),
        'application/json',
        `Review verdict round ${String(this.round)}`,
      );
      this.reviews.push({
        round: this.round,
        resourceId: reviewed.resourceId,
        verdict: review.verdict,
        valid: review.valid,
        findings: counts,
        reasonCodes: [
          ...reviewed.reasonCodes.filter((c) => c.startsWith('review.')),
          ...(review.valid ? [] : [review.summary]),
        ],
        outputSha256,
      });
      await this.step('review.completed', {
        round: this.round,
        resourceId: reviewed.resourceId,
        verdict: review.verdict,
        valid: review.valid,
        ...counts,
      });
      if (review.verdict === 'request-changes') {
        if (this.round >= settings.maxReworkRounds) {
          throw new TaskEnd('not-accepted', 'review.changes-requested');
        }
        await this.rework(
          review.findings
            .map((f) => `[${f.severity}]${f.file === undefined ? '' : ` ${f.file}:`} ${f.message}`)
            .join('\n'),
        );
        continue;
      }
      return { harvest, review, reviewer: reviewed.resourceId, gatesPassed: gates.length };
    }
  }

  /** The built-in `debugging` lane: same worktree, next round. */
  private async rework(findings: string): Promise<void> {
    this.round += 1;
    await this.runLane(this.debuggingSpec(), this.work(), 'read-write', {
      goal: this.target.goal,
      ...(this.planText === undefined ? {} : { plan: this.planText }),
      findings,
      round: this.round,
    });
  }

  private async accept(accepted: {
    harvest: HarvestResult;
    review: ReviewVerdict;
    reviewer: string;
    gatesPassed: number;
  }): Promise<void> {
    const { harvest } = accepted;
    const { settings, project, taskId, repository } = this.target;
    const worktree = this.worktree as TaskWorktree;
    await this.step('acceptance.decided', {
      accepted: true,
      ownerApproval: settings.ownerApproval,
      patchSha256: harvest.sha256,
      gatesPassed: accepted.gatesPassed,
      reviewVerdict: accepted.review.verdict,
    });

    const action: OutwardAction = {
      type: 'engineering.commit',
      target: `${project.id}:${this.branch}`,
      parameters: {
        repository,
        baseCommit: worktree.baseCommit,
        patchSha256: harvest.sha256,
        branch: this.branch,
      },
    };
    let grant: ApprovalGrant | undefined;
    if (settings.ownerApproval === 'always') {
      const ttlMs = this.deps.approvalTtlMs;
      this.progress({
        type: 'awaiting-approval',
        taskId,
        projectId: project.id,
        branch: this.branch,
        baseCommit: worktree.baseCommit,
        patchSha256: harvest.sha256,
        files: harvest.entries.length,
        gatesPassed: accepted.gatesPassed,
        reviewVerdict: accepted.review.verdict,
        ttlMs,
      });
      grant = await this.requestApproval(action, accepted, ttlMs);
      this.approval = { id: grant.approvalId, outcome: 'approved' };
    } else {
      this.approval = { outcome: 'not-required' };
    }
    await this.persist();
    this.checkCancelled();

    if (grant !== undefined) await this.consume(grant, action);
    const trailers: Record<string, string> = {
      'Nexar-Task': taskId,
      'Nexar-Plan': this.deps.plan.id,
    };
    this.laneExecutions.forEach((lane, index) => {
      trailers[`Nexar-Lane-${String(index + 1)}`] = `${lane.role}=${lane.resourceId}`;
    });
    trailers['Nexar-Reviewer'] = accepted.reviewer;
    trailers['Nexar-Patch-Sha256'] = harvest.sha256;
    trailers['Nexar-Approval'] = grant?.approvalId ?? 'none';

    const result = await this.deps.worktrees.commitPatch({
      repository,
      baseCommit: worktree.baseCommit,
      harvest,
      branch: this.branch,
      message: commitSubject(this.target.goal),
      author: this.deps.author,
      trailers,
    });
    this.commit = result.commit;
    this.status = 'committed';
    await this.step('commit.created', {
      commit: result.commit,
      branch: result.branch,
      patchSha256: harvest.sha256,
    });
  }

  private async requestApproval(
    action: OutwardAction,
    accepted: { harvest: HarvestResult; review: ReviewVerdict; gatesPassed: number },
    ttlMs: number,
  ): Promise<ApprovalGrant> {
    const { project, taskId } = this.target;
    try {
      return await this.deps.approvals.request(action, {
        summary: `${commitSubject(this.target.goal)} (${String(accepted.harvest.entries.length)} files, review ${accepted.review.verdict}) → ${this.branch}`,
        risk: 'medium',
        taskId,
        projectId: project.id,
        metadata: {
          engineeringTaskId: taskId,
          patchSha256: accepted.harvest.sha256,
          files: accepted.harvest.entries.length,
          gatesPassed: accepted.gatesPassed,
          reviewVerdict: accepted.review.verdict,
          branch: this.branch,
        },
        ttlMs,
        ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
      });
    } catch (error) {
      throw this.refusal(error);
    }
  }

  private async consume(grant: ApprovalGrant, action: OutwardAction): Promise<void> {
    try {
      await grant.consume(action);
    } catch (error) {
      throw this.refusal(error);
    }
  }

  /** Maps an approval failure to `not-accepted` (fail closed); anything else stays an error. */
  private refusal(error: unknown): unknown {
    if (this.options.signal?.aborted === true) return new TaskEnd('cancelled', 'cancelled');
    if (!isNexarError(error) || error.code !== 'APPROVAL_DENIED') return error;
    const details = (error.details ?? {}) as { approvalId?: unknown; reason?: unknown };
    const reason = typeof details.reason === 'string' ? details.reason : 'denied';
    this.approval = {
      ...(typeof details.approvalId === 'string' ? { id: details.approvalId } : {}),
      outcome: reason,
    };
    return new TaskEnd('not-accepted', `approval.${reason}`);
  }
}
