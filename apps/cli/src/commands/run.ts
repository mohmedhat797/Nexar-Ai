import { projectId, type ArtifactRef } from '@nexar/contracts';
import type { ProjectRegistry } from '@nexar/projects';
import {
  TASK_OPTIONS,
  buildTask,
  flagOption,
  listOption,
  stringOption,
  type Command,
  type CommandContext,
} from '../args.js';
import { compose, loadCliConfig } from '../composition.js';
import { formatMeasured } from '../format.js';
import { EXIT, UsageError } from '../io.js';
import { explainRouteDecision } from '@nexar/resource-controller';
import { runWorkflow } from './run-workflow.js';

function parseTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms <= 0) {
    throw new UsageError(`--timeout must be a positive integer (milliseconds), got "${raw}"`);
  }
  return ms;
}

/** `--document-set` names resolve (as references, never contents) within the `--project`. */
async function resolveDocumentSets(
  projects: ProjectRegistry,
  ctx: CommandContext,
): Promise<ArtifactRef[]> {
  const names = listOption(ctx, 'document-set');
  if (names.length === 0) return [];
  const id = stringOption(ctx, 'project');
  if (id === undefined) throw new UsageError('--document-set requires --project <id>');
  const project = projects.require(projectId(id));
  const refs: ArtifactRef[] = [];
  for (const name of names) refs.push(...(await projects.resolveDocumentSet(project, name)));
  return refs;
}

export const runCommand: Command = {
  name: 'run',
  summary: 'Route a task to a resource and execute it',
  usage:
    'nexar run --kind <kind> [--capability <c>]... [--prefer <id>]... [--exclude <id>]... [--local-only]\n' +
    '          [--project <id>] [--document-set <name>]... [--timeout <ms>] [--cwd <dir>] [--quiet]\n' +
    '          [--json] <prompt... | ->\n' +
    '       nexar run --workflow <id> --project <id> [--input name=value]... [--input-file name=path]...\n' +
    '          [--list-input name=a,b]... [--local-only] [--timeout <ms>] [--quiet] [--json]\n\n' +
    'A workflow reads its inputs (see "nexar workflows list"), saves its result as artifacts and\n' +
    'prints their paths; nothing is sent anywhere. All input values are untrusted text for the\n' +
    'model. --input-file reads a local file (at most 100 KB). Invalid input exits with code 2 and\n' +
    'lists every problem; nothing runs.',
  options: {
    ...TASK_OPTIONS,
    timeout: { type: 'string' },
    cwd: { type: 'string' },
    'document-set': { type: 'string', multiple: true },
    quiet: { type: 'boolean' },
    workflow: { type: 'string' },
    input: { type: 'string', multiple: true },
    'input-file': { type: 'string', multiple: true },
    'list-input': { type: 'string', multiple: true },
  },
  async run(ctx) {
    const timeoutMs = parseTimeout(stringOption(ctx, 'timeout'));
    if (stringOption(ctx, 'workflow') !== undefined) return runWorkflow(ctx, timeoutMs);
    for (const flag of ['input', 'input-file', 'list-input']) {
      if (listOption(ctx, flag).length > 0) throw new UsageError(`--${flag} requires --workflow`);
    }
    const quiet = flagOption(ctx, 'quiet');
    const cwd = stringOption(ctx, 'cwd');
    const loaded = await loadCliConfig(ctx.io, ctx.configPath);
    const { runtime } = await compose(loaded, ctx.io, ctx.logger);
    const attachments = await resolveDocumentSets(runtime.projects, ctx);
    const task = await buildTask(runtime.nexar, ctx, {
      ...(cwd === undefined ? {} : { cwd }),
      attachments,
    });

    const abort = new AbortController();
    const onSigint = (): void => abort.abort(new Error('interrupted (SIGINT)'));
    process.once('SIGINT', onSigint);
    try {
      const outcome = await runtime.nexar.run(task, {
        signal: abort.signal,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        onEvent: (event) => {
          // Text is printed once, as the final result; only progress goes to stderr.
          if (!quiet && event.type === 'status') ctx.io.stderr(`[event] ${event.message}\n`);
        },
      });
      const { decision, result, record } = outcome;
      if (!quiet) ctx.io.stderr(explainRouteDecision(decision) + '\n');

      if (ctx.json) {
        const { text, usage, resolved } = result;
        ctx.io.stdout(
          JSON.stringify({ decision, result: { text, usage, resolved }, record }, null, 2) + '\n',
        );
      } else {
        ctx.io.stdout(result.text.endsWith('\n') ? result.text : result.text + '\n');
      }
      ctx.io.stderr(
        `resource=${record.resourceId} model=${record.model ?? 'unknown'} outcome=${record.outcome} ` +
          `latency=${String(record.latencyMs)}ms ` +
          `tokens=${formatMeasured(record.usage.inputTokens)}/${formatMeasured(record.usage.outputTokens)} ` +
          `cost=${formatMeasured(record.usage.costUsd)}\n`,
      );
      return EXIT.ok;
    } finally {
      process.removeListener('SIGINT', onSigint);
    }
  },
};
