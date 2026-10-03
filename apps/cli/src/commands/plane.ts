import { userInfo } from 'node:os';
import { join } from 'node:path';
import { FileApprovalStore, decide, type ApprovalStore } from '@nexar/approvals';
import { isNexarError, projectId as toProjectId, type NexarErrorCode } from '@nexar/contracts';
import type { LoadedConfig } from '@nexar/core';
import {
  readTaskPatch,
  type EngineeringOutcome,
  type EngineeringProgress,
} from '@nexar/engineering';
import {
  MAX_DIFF_BYTES,
  MAX_DIFF_FILES,
  MAX_OUTCOME_LANES,
  PLANE_PROTOCOL,
  createDesktopFrameDecoder,
  encodeFrame,
  type DecodeFailure,
  type DesktopFrame,
  type PlaneFrame,
  type ProgressEvent,
  type RunFrame,
} from '@nexar/plane-protocol';
import type { Command, CommandContext } from '../args.js';
import {
  composeEngineering,
  loadCliConfig,
  nexarStateDir,
  type EngineeringComposition,
} from '../composition.js';
import { EXIT, UsageError } from '../io.js';
import { buildReadiness, planIds } from '../plane-readiness.js';
import { CLI_VERSION } from '../version.js';

const USAGE = 'nexar plane serve --stdio';

const DEFAULT_APPROVAL_POLL_MS = 250;
const DEFAULT_SETTLE_TIMEOUT_MS = 10_000;
/** More than this many decode failures in a row end the connection. */
const MAX_CONSECUTIVE_DECODE_FAILURES = 8;
/** The approval lookup gives up this long after the approval's own lifetime. */
const APPROVAL_LOOKUP_SLACK_MS = 5_000;
const MIN_DIFF_BYTES = 1024;
/** The plan every `review` intent runs (ADR-025 amendment); the request never names it. */
const REPORT_PLAN_ID = 'repository-report';
/** The plan every `plan` intent runs (NXR-053); forced like the report plan. */
const IMPLEMENTATION_PLAN_ID = 'implementation-plan';

/** The fixed text per code: nothing from an error, a goal, a path or a record is ever echoed. */
const MESSAGES: Readonly<Partial<Record<NexarErrorCode, string>>> = {
  CONFIGURATION_ERROR: 'The plane is not configured for engineering',
  POLICY_REJECTED: 'The request was rejected by plane policy',
  VALIDATION_ERROR: 'The request was not valid',
  SANDBOX_UNAVAILABLE: 'The sandbox is not available',
  APPROVAL_DENIED: 'The approval can no longer be decided',
  CONFLICT: 'The plane is busy',
};

function messageFor(code: NexarErrorCode): string {
  return MESSAGES[code] ?? `The plane could not complete the request (${code})`;
}

function codeOf(error: unknown): NexarErrorCode {
  return isNexarError(error) ? error.code : 'INTERNAL_ERROR';
}

const DECODE_MESSAGES: Readonly<Record<DecodeFailure, string>> = {
  oversize: 'A frame exceeded the size limit',
  malformed: 'A frame was not valid JSON',
  'forbidden-key': 'A frame contained a forbidden key',
  'unknown-type': 'The frame type is not supported by this plane',
  schema: 'A frame did not match the protocol',
};

/** A decider name that cannot carry control characters into the approval record. */
function deciderName(ctx: CommandContext): string {
  let user = ctx.seams.plane?.user;
  if (user === undefined) {
    try {
      user = userInfo().username;
    } catch {
      user = 'unknown';
    }
  }
  const clean = user.replace(/[^A-Za-z0-9._@-]/g, '_').slice(0, 64);
  return `desktop:${clean === '' ? 'unknown' : clean}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** A step's `detail` is scalar by construction; clamp it so one odd value cannot drop the frame. */
function progressEvent(event: EngineeringProgress): ProgressEvent {
  if (event.type !== 'step') return event;
  const detail: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(event.detail).slice(0, 32)) {
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    detail[key.slice(0, 64)] = typeof value === 'string' ? value.slice(0, 500) : value;
  }
  return { type: 'step', step: event.step, detail };
}

interface ActiveRun {
  readonly runId: string;
  /** A report run (intent `review` or `plan`): it never has an approval to announce. */
  readonly report: boolean;
  readonly controller: AbortController;
  settled: boolean;
  done: Promise<void>;
}

/** The loaded config plus the engineering composition, built on the first run. */
interface Engine {
  readonly composition: EngineeringComposition;
}

async function serve(ctx: CommandContext): Promise<number> {
  const input = ctx.io.stdinChunks;
  if (input === undefined) throw new UsageError('standard input is not available');
  const settings = ctx.seams.plane;
  const pollMs = settings?.approvalPollMs ?? DEFAULT_APPROVAL_POLL_MS;
  const settleTimeoutMs = settings?.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;

  const send = (frame: PlaneFrame): void => {
    try {
      ctx.io.stdout(encodeFrame(frame));
    } catch (error) {
      // Programming error or an oversize frame: say so on stderr (code only), keep the stream valid.
      ctx.logger.warn('plane frame was not sent', { type: frame.type, code: codeOf(error) });
    }
  };
  const sendError = (code: NexarErrorCode, runId?: string, message = messageFor(code)): void =>
    send({ type: 'error', ...(runId === undefined ? {} : { runId }), code, message });

  let loaded: LoadedConfig | undefined;
  let store: ApprovalStore | undefined;
  let engine: Promise<Engine> | undefined;
  let active: ActiveRun | undefined;
  /** Approval ids announced to Desktop in this process, still undecided. */
  const announced = new Set<string>();
  /** Task ids this process produced; the only ones `diff` answers for. */
  const knownTasks = new Set<string>();

  const getEngine = (): Promise<Engine> => {
    engine ??= (async () => {
      const config = loaded as LoadedConfig;
      const composition = await composeEngineering(
        config,
        ctx.io,
        ctx.logger,
        ctx.seams.engineering,
        ctx.seams.sandbox?.availability,
      );
      return { composition };
    })();
    return engine;
  };

  // ---- run ---------------------------------------------------------------------------------

  const announceApproval = async (run: ActiveRun, event: EngineeringProgress): Promise<void> => {
    if (event.type !== 'awaiting-approval' || store === undefined) return;
    const deadline = Date.now() + event.ttlMs + APPROVAL_LOOKUP_SLACK_MS;
    while (!run.settled && !run.controller.signal.aborted && Date.now() < deadline) {
      let pending: Awaited<ReturnType<ApprovalStore['list']>> = [];
      try {
        pending = await store.list({ status: 'pending' });
      } catch {
        // The store is read again on the next round; a failing store means "not found yet".
      }
      const match = pending.find(
        (record) =>
          record.actionType === 'engineering.commit' &&
          record.taskId === event.taskId &&
          record.metadata?.['patchSha256'] === event.patchSha256,
      );
      if (match !== undefined) {
        announced.add(match.id);
        send({
          type: 'approval-required',
          runId: run.runId,
          approvalId: match.id,
          summary: {
            taskId: event.taskId,
            branch: event.branch,
            files: event.files,
            gatesPassed: event.gatesPassed,
            reviewVerdict: event.reviewVerdict,
            patchSha256: event.patchSha256,
            ttlMs: event.ttlMs,
          },
        });
        return;
      }
      await sleep(pollMs, run.controller.signal);
    }
  };

  const outcomeView = (outcome: EngineeringOutcome) => ({
    taskId: outcome.taskId,
    status: outcome.status,
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason.slice(0, 200) }),
    ...(outcome.branch === undefined ? {} : { branch: outcome.branch }),
    ...(outcome.commit === undefined ? {} : { commit: outcome.commit }),
    // The report is bounded by the runner; only a `reported` outcome may carry one.
    ...(outcome.status === 'reported' && outcome.report !== undefined
      ? { report: { text: outcome.report.text, truncated: outcome.report.truncated } }
      : {}),
    ...(outcome.lanes === undefined || outcome.lanes.length === 0
      ? {}
      : {
          lanes: outcome.lanes.slice(0, MAX_OUTCOME_LANES).map((lane) => ({
            role: lane.role.slice(0, 64),
            resourceId: lane.resourceId.slice(0, 128),
          })),
        }),
  });

  const execute = async (run: ActiveRun, frame: RunFrame): Promise<void> => {
    const finish = (): void => {
      run.settled = true;
      if (active === run) active = undefined;
    };
    try {
      // A review or plan always runs its report plan: the frame's planId can never route it to a
      // change plan.
      let planId = frame.planId;
      if (run.report) {
        const forced = frame.intent === 'plan' ? IMPLEMENTATION_PLAN_ID : REPORT_PLAN_ID;
        if (!(await planIds(ctx.io, ctx.seams)).includes(forced)) {
          finish();
          sendError(
            'POLICY_REJECTED',
            run.runId,
            'Report-only engineering plans are not available',
          );
          return;
        }
        planId = forced;
      }
      const { composition } = await getEngine();
      const project = composition.runtime.projects.get(toProjectId(frame.planeProject));
      if (project?.engineering === undefined) {
        finish();
        sendError('VALIDATION_ERROR', run.runId, 'Unknown project');
        return;
      }
      const outcome = await composition.runner.run(
        {
          projectId: frame.planeProject,
          goal: frame.goal,
          // An older Desktop sends no title: the commit subject then falls back to the goal.
          ...(frame.title === undefined ? {} : { title: frame.title }),
          ...(planId === undefined ? {} : { planId }),
          lineage: frame.lineage,
        },
        {
          signal: run.controller.signal,
          onProgress: (event) => {
            if (event.type === 'awaiting-approval' && !run.report) {
              knownTasks.add(event.taskId);
              void announceApproval(run, event).catch(() => undefined);
            }
            send({ type: 'progress', runId: run.runId, event: progressEvent(event) });
          },
        },
      );
      knownTasks.add(outcome.taskId);
      finish();
      send({ type: 'completed', runId: run.runId, outcome: outcomeView(outcome) });
    } catch (error) {
      finish();
      const code = codeOf(error);
      ctx.logger.warn('plane run failed', { runId: run.runId, code });
      sendError(code, run.runId);
    }
  };

  const handleRun = (frame: RunFrame): void => {
    if (active !== undefined) {
      sendError('CONFLICT', frame.runId, 'A run is already active');
      return;
    }
    const run: ActiveRun = {
      runId: frame.runId,
      report: frame.intent !== 'coding',
      controller: new AbortController(),
      settled: false,
      done: Promise.resolve(),
    };
    active = run;
    ctx.logger.info('plane run started', { runId: run.runId });
    run.done = execute(run, frame);
  };

  // ---- other frames ------------------------------------------------------------------------

  const handleCancel = (runId: string): void => {
    if (active === undefined || active.runId !== runId) {
      sendError('VALIDATION_ERROR', runId, 'Unknown run');
      return;
    }
    active.controller.abort(new Error('cancelled by Desktop'));
  };

  const handleDecide = async (approvalId: string, decision: 'approve' | 'deny'): Promise<void> => {
    if (store === undefined || !announced.has(approvalId)) {
      sendError('POLICY_REJECTED', undefined, 'Unknown approval');
      return;
    }
    try {
      const current = await store.get(approvalId);
      if (current?.status !== 'pending') {
        announced.delete(approvalId);
        sendError('POLICY_REJECTED', undefined, 'The approval is no longer pending');
        return;
      }
      const updated = await decide(store, approvalId, decision, { by: deciderName(ctx) });
      announced.delete(approvalId);
      send({
        type: 'decided',
        approvalId,
        status: updated.status === 'approved' ? 'approved' : 'denied',
      });
    } catch (error) {
      sendError(codeOf(error));
    }
  };

  const handleDiff = async (taskId: string): Promise<void> => {
    if (loaded === undefined || !knownTasks.has(taskId)) {
      sendError('POLICY_REJECTED', undefined, 'Unknown task');
      return;
    }
    const stateDir = nexarStateDir(loaded, ctx.io);
    const worktreesDir = loaded.config.engineering?.worktreesDir;
    try {
      // The cap on a frame counts JSON escapes: halve the text until the frame fits.
      for (let maxBytes = MAX_DIFF_BYTES; ; maxBytes = Math.floor(maxBytes / 2)) {
        const view = await readTaskPatch({
          stateDir,
          ...(worktreesDir === undefined ? {} : { worktreesDir }),
          taskId,
          maxBytes,
          maxFiles: MAX_DIFF_FILES,
        });
        try {
          ctx.io.stdout(
            encodeFrame({
              type: 'diff',
              taskId,
              text: view.text,
              truncated: view.truncated,
              files: [...view.files],
            }),
          );
          return;
        } catch (error) {
          const tooLarge =
            isNexarError(error) &&
            (error.details as { reason?: unknown } | undefined)?.reason === 'frame-too-large';
          if (!tooLarge || maxBytes <= MIN_DIFF_BYTES) throw error;
        }
      }
    } catch (error) {
      sendError(codeOf(error), undefined, 'The diff is not available');
    }
  };

  const shutdown = async (): Promise<void> => {
    const run = active;
    if (run === undefined) return;
    run.controller.abort(new Error('plane shutting down'));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      run.done,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, settleTimeoutMs);
      }),
    ]);
    clearTimeout(timer);
  };

  // ---- the connection ----------------------------------------------------------------------

  const onSignal = new AbortController();
  const signalListener = (): void => onSignal.abort();
  process.once('SIGINT', signalListener);
  process.once('SIGTERM', signalListener);
  const stopped = new Promise<'stop'>((resolve) =>
    onSignal.signal.addEventListener('abort', () => resolve('stop'), { once: true }),
  );

  const decoder = createDesktopFrameDecoder();
  const iterator = input()[Symbol.asyncIterator]();
  let initialized = false;
  let failures = 0;

  /** Returns an exit code to end the connection, or `undefined` to continue. */
  const handle = async (frame: DesktopFrame): Promise<number | undefined> => {
    if (!initialized) {
      if (frame.type !== 'initialize') {
        sendError('VALIDATION_ERROR', undefined, 'The first frame must be initialize');
        return EXIT.failure;
      }
      if (frame.protocol !== PLANE_PROTOCOL) {
        sendError(
          'VALIDATION_ERROR',
          undefined,
          `Unsupported protocol; this plane speaks ${PLANE_PROTOCOL}`,
        );
        return EXIT.failure;
      }
      try {
        loaded = await loadCliConfig(ctx.io, ctx.configPath);
        store =
          ctx.seams.plane?.approvalStore ??
          new FileApprovalStore(join(nexarStateDir(loaded, ctx.io), 'approvals'));
        const readiness = await buildReadiness(loaded, ctx.io, ctx.seams);
        initialized = true;
        send({ type: 'ready', protocol: PLANE_PROTOCOL, planeVersion: CLI_VERSION, readiness });
      } catch (error) {
        sendError(codeOf(error));
        return EXIT.failure;
      }
      return undefined;
    }
    switch (frame.type) {
      case 'initialize':
        sendError('VALIDATION_ERROR', undefined, 'Already initialized');
        return undefined;
      case 'run':
        handleRun(frame);
        return undefined;
      case 'cancel':
        handleCancel(frame.runId);
        return undefined;
      case 'decide':
        await handleDecide(frame.approvalId, frame.decision);
        return undefined;
      case 'diff':
        await handleDiff(frame.taskId);
        return undefined;
      case 'shutdown':
        return EXIT.ok;
    }
  };

  const finishWith = async (code: number): Promise<number> => {
    await shutdown();
    await iterator.return?.();
    return code;
  };

  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), stopped]);
      if (next === 'stop' || next.done === true) return await finishWith(EXIT.ok);
      for (const result of decoder.push(next.value)) {
        if (result.ok) {
          failures = 0;
          const exit = await handle(result.frame);
          if (exit !== undefined) return await finishWith(exit);
          continue;
        }
        failures += 1;
        sendError('VALIDATION_ERROR', undefined, DECODE_MESSAGES[result.failure]);
        if (!initialized || result.failure === 'unknown-type')
          return await finishWith(EXIT.failure);
        if (failures > MAX_CONSECUTIVE_DECODE_FAILURES) return await finishWith(EXIT.failure);
      }
    }
  } finally {
    process.removeListener('SIGINT', signalListener);
    process.removeListener('SIGTERM', signalListener);
  }
}

export const planeCommand: Command = {
  name: 'plane',
  summary: 'Serve the engineering plane to Desktop over stdio (inside WSL2; protocol frames only)',
  usage: `${USAGE}\n\nstdout carries newline-delimited protocol frames only; logs go to stderr.`,
  options: { stdio: { type: 'boolean' } },
  async run(ctx) {
    if (
      ctx.positionals.length !== 1 ||
      ctx.positionals[0] !== 'serve' ||
      ctx.values['stdio'] !== true ||
      ctx.json
    ) {
      throw new UsageError(`usage: ${USAGE}`);
    }
    return serve(ctx);
  },
};
