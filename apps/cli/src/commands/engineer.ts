import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { projectId as toProjectId, type NexarErrorCode } from '@nexar/contracts';
import {
  listEngineeringRecords,
  readEngineeringRecord,
  recordPathFor,
  PlanCatalog,
  type EngineeringOutcome,
  type EngineeringProgress,
  type EngineeringRecord,
} from '@nexar/engineering';
import { stringOption, type Command, type CommandContext } from '../args.js';
import {
  builtinEngineeringPlansDir,
  composeEngineering,
  loadCliConfig,
  nexarStateDir,
  type EgressCounts,
} from '../composition.js';
import { renderTable } from '../format.js';
import { EXIT, UsageError, exitCodeFor } from '../io.js';

const USAGE = [
  'nexar engineer run --project <id> [--plan <id>] [--base <branch>] [--json] (<goal…> | --goal-file <path>)',
  'nexar engineer list [--json]',
  'nexar engineer show <task-id> [--json]',
  'nexar engineer plans [--json]',
  'nexar engineer cleanup <task-id>',
].join('\n       ');

/** A `--goal-file` may not be larger than this. */
export const MAX_GOAL_FILE_BYTES = 64 * 1024;
const MS_PER_MINUTE = 60_000;
const ERROR_CODE_SUFFIX = /\.([A-Z][A-Z_]+)$/;

/** Record and progress text is machine-made, but never let it write control sequences to a terminal. */
function plain(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, ' ');
}

/** The goal file is the owner's own path: read it as given and never put the path in an error. */
async function readGoalFile(ctx: CommandContext, path: string): Promise<string> {
  const failure = (why: string): UsageError => new UsageError(`--goal-file: the file ${why}`);
  let text: string;
  try {
    const handle = await open(resolve(ctx.io.cwd, path), 'r');
    try {
      if ((await handle.stat()).size > MAX_GOAL_FILE_BYTES) throw new RangeError('too large');
      text = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw failure(error instanceof RangeError ? 'is larger than 64 KiB' : 'cannot be read');
  }
  if (Buffer.byteLength(text) > MAX_GOAL_FILE_BYTES) throw failure('is larger than 64 KiB');
  return text.replace(/\r?\n$/, '');
}

async function readGoal(ctx: CommandContext, words: readonly string[]): Promise<string> {
  const file = stringOption(ctx, 'goal-file');
  if (file !== undefined && words.length > 0) {
    throw new UsageError('a goal and --goal-file cannot be combined');
  }
  const goal = file === undefined ? words.join(' ') : await readGoalFile(ctx, file);
  if (goal.trim() === '') throw new UsageError('a goal is required');
  return goal;
}

/** Prints scalar-only progress. Never the goal, prompts, diffs, gate output or paths. */
function progressPrinter(
  ctx: CommandContext,
  gateTotal: number,
): (event: EngineeringProgress) => void {
  const say = (line: string): void => ctx.io.stderr(`[engineer] ${plain(line)}\n`);
  let gatesPassed = 0;
  let gateRound = -1;
  return (event) => {
    if (event.type === 'awaiting-approval') {
      const minutes = Math.max(1, Math.round(event.ttlMs / MS_PER_MINUTE));
      say(
        `awaiting owner approval: run 'nexar approvals list' then 'nexar approvals approve <id>' ` +
          `(expires in ${String(minutes)} min)`,
      );
      say(`  branch: ${event.branch}`);
      say(`  files:  ${String(event.files)}`);
      say(`  patch:  ${event.patchSha256}`);
      return;
    }
    if (event.type !== 'step') return;
    const d = event.detail;
    const round = typeof d['round'] === 'number' ? d['round'] + 1 : undefined;
    const suffix = round === undefined ? '' : ` (r${String(round)})`;
    switch (event.step) {
      case 'lane.completed':
        say(
          d['outcome'] === 'succeeded'
            ? `lane ${String(d['lane'])} → ${String(d['resourceId'])}${suffix}`
            : `lane ${String(d['lane'])} ${String(d['outcome'])}: ${String(d['errorCode'] ?? 'error')}${suffix}`,
        );
        break;
      case 'patch.harvested':
        say(
          `patch harvested: ${String(d['files'])} file(s)` +
            (d['valid'] === true ? '' : ' (violates the patch policy)'),
        );
        break;
      case 'gate.completed': {
        if (d['phase'] !== 'gate') {
          if (d['passed'] !== true)
            say(`${String(d['phase'])} ${String(d['name'])} failed${suffix}`);
          break;
        }
        const thisRound = typeof d['round'] === 'number' ? d['round'] : 0;
        if (thisRound !== gateRound) {
          gateRound = thisRound;
          gatesPassed = 0;
        }
        if (d['passed'] === true) gatesPassed += 1;
        if (d['passed'] !== true) {
          say(
            `gate ${String(d['name'])} ${d['timedOut'] === true ? 'timed out' : 'failed'}${suffix}`,
          );
        } else if (gatesPassed === gateTotal) {
          say(`gates ${String(gatesPassed)}/${String(gateTotal)} passed${suffix}`);
        }
        break;
      }
      case 'review.completed':
        say(
          `review by ${String(d['resourceId'])}: ${String(d['verdict'])}` +
            (d['valid'] === true ? '' : ' (invalid verdict)') +
            suffix,
        );
        break;
      default:
        break;
    }
  };
}

/** Maps `lane.feature.AUTH_REQUIRED`-style failure reasons onto the shared exit codes. */
function exitForFailure(reason: string | undefined): number {
  const code = reason === undefined ? undefined : ERROR_CODE_SUFFIX.exec(reason)?.[1];
  return code === undefined ? EXIT.failure : exitCodeFor(code as NexarErrorCode);
}

function exitForOutcome(outcome: EngineeringOutcome): number {
  switch (outcome.status) {
    case 'committed':
    case 'reported':
      return EXIT.ok;
    case 'not-accepted':
      return EXIT.notAccepted;
    case 'cancelled':
      return EXIT.interrupted;
    case 'failed':
      return exitForFailure(outcome.reason);
  }
}

/** The outcome without `recordPath` (an absolute path): `nexar engineer show <task>` has the rest. */
function outcomeView(outcome: EngineeringOutcome, egress: EgressCounts): Record<string, unknown> {
  return {
    taskId: outcome.taskId,
    status: outcome.status,
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    ...(outcome.branch === undefined ? {} : { branch: outcome.branch }),
    ...(outcome.commit === undefined ? {} : { commit: outcome.commit }),
    egress: { allowed: egress.allowed, denied: egress.denied },
  };
}

async function run(ctx: CommandContext, words: readonly string[]): Promise<number> {
  const project = stringOption(ctx, 'project');
  if (project === undefined || project === '') throw new UsageError('--project <id> is required');
  const planId = stringOption(ctx, 'plan');
  const base = stringOption(ctx, 'base');
  try {
    toProjectId(project);
  } catch {
    throw new UsageError('invalid project id');
  }
  const goal = await readGoal(ctx, words);

  const loaded = await loadCliConfig(ctx.io, ctx.configPath);
  const { runtime, runner, egress } = await composeEngineering(
    loaded,
    ctx.io,
    ctx.logger,
    ctx.seams.engineering,
    ctx.seams.sandbox?.availability,
  );
  const gateTotal = runtime.projects.get(toProjectId(project))?.engineering?.gates.length ?? 0;

  const abort = new AbortController();
  const onSigint = (): void => abort.abort(new Error('interrupted (SIGINT)'));
  process.once('SIGINT', onSigint);
  let outcome: EngineeringOutcome;
  try {
    outcome = await runner.run(
      {
        projectId: project,
        goal,
        ...(planId === undefined ? {} : { planId }),
        ...(base === undefined ? {} : { baseBranch: base }),
      },
      { signal: abort.signal, onProgress: progressPrinter(ctx, gateTotal) },
    );
  } finally {
    process.removeListener('SIGINT', onSigint);
  }

  if (ctx.json) {
    ctx.io.stdout(JSON.stringify(outcomeView(outcome, egress), null, 2) + '\n');
  } else {
    const lines = [`task ${outcome.taskId}: ${outcome.status}`];
    if (outcome.reason !== undefined) lines.push(`reason: ${plain(outcome.reason)}`);
    if (outcome.branch !== undefined) lines.push(`branch: ${outcome.branch}`);
    if (outcome.commit !== undefined) lines.push(`commit: ${outcome.commit}`);
    lines.push(`egress: ${String(egress.allowed)} allowed, ${String(egress.denied)} denied`);
    ctx.io.stdout(lines.join('\n') + '\n');
  }
  return exitForOutcome(outcome);
}

async function list(ctx: CommandContext): Promise<number> {
  const loaded = await loadCliConfig(ctx.io, ctx.configPath);
  const records = await listEngineeringRecords(nexarStateDir(loaded, ctx.io));
  if (ctx.json) {
    ctx.io.stdout(JSON.stringify(records, null, 2) + '\n');
  } else if (records.length === 0) {
    ctx.io.stdout('no engineering tasks\n');
  } else {
    ctx.io.stdout(
      renderTable(
        ['TASK', 'STATUS', 'PROJECT', 'PLAN', 'STARTED', 'REASON'],
        records.map((r) => [
          r.taskId,
          r.status,
          plain(r.projectId),
          plain(r.planId),
          r.startedAt,
          r.reason === undefined ? '-' : plain(r.reason),
        ]),
      ) + '\n',
    );
  }
  return EXIT.ok;
}

function renderRecord(r: EngineeringRecord): string {
  const lines = [
    `task:     ${r.taskId}`,
    `status:   ${r.status}${r.reason === undefined ? '' : ` (${plain(r.reason)})`}`,
    `project:  ${plain(r.projectId)}`,
    `plan:     ${plain(r.planId)}`,
    `started:  ${r.startedAt}`,
    ...(r.endedAt === undefined ? [] : [`ended:    ${r.endedAt}`]),
    `base:     ${plain(r.baseBranch)}${r.baseCommit === undefined ? '' : ` @ ${r.baseCommit}`}`,
    `branch:   ${r.branch}${r.commit === undefined ? '' : ` @ ${r.commit}`}`,
    `rounds:   ${String(r.round)} rework`,
  ];
  if (r.approval !== undefined) {
    lines.push(
      `approval: ${plain(r.approval.outcome)}${r.approval.id === undefined ? '' : ` (${r.approval.id})`}`,
    );
  }
  const section = (title: string, header: string[], rows: string[][]): void => {
    if (rows.length === 0) return;
    lines.push('', title, renderTable(header, rows));
  };
  section(
    'Lanes',
    ['LANE', 'ROLE', 'ROUND', 'RESOURCE', 'OUTCOME', 'MS'],
    r.lanes.map((l) => [
      plain(l.laneId),
      plain(l.role),
      String(l.round),
      l.resourceId === undefined ? '-' : plain(l.resourceId),
      l.errorCode === undefined ? l.outcome : `${l.outcome} (${plain(l.errorCode)})`,
      String(l.latencyMs),
    ]),
  );
  section(
    'Commands',
    ['PHASE', 'NAME', 'ROUND', 'EXIT', 'PASSED', 'MS'],
    r.commands.map((c) => [
      c.phase,
      plain(c.name),
      String(c.round),
      c.exitCode === null ? (c.timedOut ? 'timeout' : '-') : String(c.exitCode),
      c.passed ? 'yes' : 'no',
      String(c.durationMs),
    ]),
  );
  section(
    'Patches',
    ['ROUND', 'FILES', 'BYTES', 'VALID', 'SHA256'],
    r.patches.map((p) => [
      String(p.round),
      String(p.files),
      String(p.bytes),
      p.valid ? 'yes' : 'no',
      p.sha256,
    ]),
  );
  section(
    'Reviews',
    ['ROUND', 'RESOURCE', 'VERDICT', 'VALID', 'B/M/m/n'],
    r.reviews.map((v) => [
      String(v.round),
      plain(v.resourceId),
      v.verdict,
      v.valid ? 'yes' : 'no',
      `${String(v.findings.blocker)}/${String(v.findings.major)}/${String(v.findings.minor)}/${String(v.findings.nit)}`,
    ]),
  );
  return lines.join('\n') + '\n';
}

async function show(ctx: CommandContext, taskId: string | undefined): Promise<number> {
  if (taskId === undefined) throw new UsageError('usage: nexar engineer show <task-id> [--json]');
  const loaded = await loadCliConfig(ctx.io, ctx.configPath);
  const stateDir = nexarStateDir(loaded, ctx.io);
  try {
    recordPathFor(stateDir, taskId); // rejects a malformed id before anything is read
  } catch {
    throw new UsageError('invalid engineering task id');
  }
  const record = await readEngineeringRecord(stateDir, taskId);
  if (record === undefined) {
    ctx.io.stderr('nexar: unknown engineering task\n');
    return EXIT.failure;
  }
  ctx.io.stdout(ctx.json ? JSON.stringify(record, null, 2) + '\n' : renderRecord(record));
  return EXIT.ok;
}

async function plans(ctx: CommandContext): Promise<number> {
  const catalog = await PlanCatalog.load(builtinEngineeringPlansDir(ctx.io));
  const all = catalog.list();
  if (ctx.json) {
    ctx.io.stdout(
      JSON.stringify(
        all.map((p) => ({
          id: p.id,
          displayName: p.displayName,
          description: p.description,
          lanes: p.lanes.map((l) => ({ id: l.id, role: l.role, access: l.access })),
        })),
        null,
        2,
      ) + '\n',
    );
  } else {
    ctx.io.stdout(
      renderTable(
        ['PLAN', 'LANES', 'DESCRIPTION'],
        all.map((p) => [p.id, p.lanes.map((l) => l.role).join(' → '), plain(p.description)]),
      ) + '\n',
    );
  }
  return EXIT.ok;
}

async function cleanup(ctx: CommandContext, taskId: string | undefined): Promise<number> {
  if (taskId === undefined) throw new UsageError('usage: nexar engineer cleanup <task-id>');
  const loaded = await loadCliConfig(ctx.io, ctx.configPath);
  const { runner } = await composeEngineering(
    loaded,
    ctx.io,
    ctx.logger,
    ctx.seams.engineering,
    ctx.seams.sandbox?.availability,
  );
  await runner.cleanup(taskId);
  ctx.io.stdout(`${taskId} worktree removed\n`);
  return EXIT.ok;
}

export const engineerCommand: Command = {
  name: 'engineer',
  summary: 'Run, list and inspect sandboxed engineering tasks (Nexar-owned commits, never pushed)',
  usage: USAGE,
  options: {
    project: { type: 'string' },
    plan: { type: 'string' },
    base: { type: 'string' },
    'goal-file': { type: 'string' },
  },
  async run(ctx) {
    const [action, ...rest] = ctx.positionals;
    switch (action) {
      case 'run':
        return run(ctx, rest);
      case 'list':
        if (rest.length === 0) return list(ctx);
        break;
      case 'show':
        if (rest.length <= 1) return show(ctx, rest[0]);
        break;
      case 'plans':
        if (rest.length === 0) return plans(ctx);
        break;
      case 'cleanup':
        if (rest.length <= 1) return cleanup(ctx, rest[0]);
        break;
    }
    throw new UsageError(`usage: ${USAGE}`);
  },
};
