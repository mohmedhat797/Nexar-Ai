import { userInfo } from 'node:os';
import { join } from 'node:path';
import { FileApprovalStore, decide, type ApprovalRequest } from '@nexar/approvals';
import { flagOption, stringOption, type Command, type CommandContext } from '../args.js';
import { loadCliConfig, stateBaseDir } from '../composition.js';
import { renderTable } from '../format.js';
import { EXIT, UsageError } from '../io.js';

const USAGE = [
  'nexar approvals list [--all] [--json]',
  'nexar approvals approve <id> [--reason <text>] [--yes]',
  'nexar approvals deny <id> [--reason <text>]',
].join('\n       ');

const FINGERPRINT_PREFIX = 12;

/** Approval text comes from other processes: never let it write control sequences to a terminal. */
function plain(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, ' ');
}

function decider(): string {
  try {
    return `cli:${userInfo().username}`;
  } catch {
    return 'cli:unknown';
  }
}

function toJson(r: ApprovalRequest): Record<string, unknown> {
  return {
    id: r.id,
    status: r.status,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    risk: r.risk,
    actionType: r.actionType,
    summary: r.summary,
    ...(r.taskId === undefined ? {} : { taskId: r.taskId }),
    ...(r.projectId === undefined ? {} : { projectId: r.projectId }),
    ...(r.clientId === undefined ? {} : { clientId: r.clientId }),
    ...(r.decidedAt === undefined ? {} : { decidedAt: r.decidedAt }),
    ...(r.decidedBy === undefined ? {} : { decidedBy: r.decidedBy }),
  };
}

async function list(store: FileApprovalStore, ctx: CommandContext): Promise<number> {
  const all = flagOption(ctx, 'all');
  const records = await store.list(all ? undefined : { status: 'pending' });
  if (ctx.json) {
    ctx.io.stdout(JSON.stringify(records.map(toJson), null, 2) + '\n');
  } else if (records.length === 0) {
    ctx.io.stdout(all ? 'no approval requests\n' : 'no pending approvals\n');
  } else {
    const dash = (v: string | undefined): string => (v === undefined ? '-' : plain(v));
    ctx.io.stdout(
      renderTable(
        [
          'ID',
          ...(all ? ['STATUS'] : []),
          'CREATED',
          'EXPIRES',
          'RISK',
          'ACTION',
          'TASK',
          'PROJECT',
          'CLIENT',
          'SUMMARY',
        ],
        records.map((r) => [
          r.id,
          ...(all ? [r.status] : []),
          r.createdAt,
          r.expiresAt,
          r.risk,
          plain(r.actionType),
          dash(r.taskId),
          dash(r.projectId),
          dash(r.clientId),
          plain(r.summary),
        ]),
      ) + '\n',
    );
  }
  return EXIT.ok;
}

/** Shows what is being approved and asks; returns an exit code to stop with, or undefined to go on. */
async function confirmApproval(
  store: FileApprovalStore,
  id: string,
  ctx: CommandContext,
): Promise<number | undefined> {
  const record = await store.get(id);
  // Unknown, decided or expired requests are not worth a prompt: `decide` reports the precise reason.
  if (
    record === undefined ||
    record.status !== 'pending' ||
    Date.now() >= Date.parse(record.expiresAt)
  ) {
    return undefined;
  }
  ctx.io.stderr(
    [
      `Approve ${plain(record.actionType)}: ${plain(record.summary)}`,
      `  risk:        ${record.risk}`,
      `  fingerprint: ${record.fingerprint.slice(0, FINGERPRINT_PREFIX)}`,
      '',
    ].join('\n'),
  );
  if (flagOption(ctx, 'yes')) return undefined;
  if (ctx.io.confirm === undefined) {
    ctx.io.stderr(
      'nexar: refusing to approve without confirmation; pass --yes or use a terminal\n',
    );
    return EXIT.usage;
  }
  if (!(await ctx.io.confirm('Approve this action?'))) {
    ctx.io.stderr('not approved\n');
    return EXIT.failure;
  }
  return undefined;
}

export const approvalsCommand: Command = {
  name: 'approvals',
  summary: 'List, approve or deny pending human-approval requests',
  usage: USAGE,
  options: { all: { type: 'boolean' }, yes: { type: 'boolean' }, reason: { type: 'string' } },
  async run(ctx) {
    const [action, id, ...extra] = ctx.positionals;
    const loaded = await loadCliConfig(ctx.io, ctx.configPath);
    const store = new FileApprovalStore(join(stateBaseDir(loaded, ctx.io), '.nexar', 'approvals'));

    if (action === 'list' && id === undefined) return list(store, ctx);
    if ((action !== 'approve' && action !== 'deny') || id === undefined || extra.length > 0) {
      throw new UsageError(`usage: ${USAGE}`);
    }
    const reason = stringOption(ctx, 'reason');
    if (action === 'approve') {
      const refusal = await confirmApproval(store, id, ctx);
      if (refusal !== undefined) return refusal;
    }
    const decided = await decide(store, id, action, {
      by: decider(),
      ...(reason === undefined ? {} : { reason }),
    });
    if (ctx.json) ctx.io.stdout(JSON.stringify(toJson(decided), null, 2) + '\n');
    else ctx.io.stdout(`${decided.id} ${decided.status}\n`);
    return EXIT.ok;
  },
};
