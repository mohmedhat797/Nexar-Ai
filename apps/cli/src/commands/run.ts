import { TASK_OPTIONS, buildTask, flagOption, stringOption, type Command } from '../args.js';
import { compose, loadCliConfig } from '../composition.js';
import { formatMeasured } from '../format.js';
import { EXIT, UsageError } from '../io.js';
import { explainRouteDecision } from '@nexar/resource-controller';

function parseTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms <= 0) {
    throw new UsageError(`--timeout must be a positive integer (milliseconds), got "${raw}"`);
  }
  return ms;
}

export const runCommand: Command = {
  name: 'run',
  summary: 'Route a task to a resource and execute it',
  usage:
    'nexar run --kind <kind> [--capability <c>]... [--prefer <id>]... [--exclude <id>]... [--local-only]\n' +
    '          [--timeout <ms>] [--cwd <dir>] [--quiet] [--json] <prompt... | ->',
  options: {
    ...TASK_OPTIONS,
    timeout: { type: 'string' },
    cwd: { type: 'string' },
    quiet: { type: 'boolean' },
  },
  async run(ctx) {
    const timeoutMs = parseTimeout(stringOption(ctx, 'timeout'));
    const quiet = flagOption(ctx, 'quiet');
    const cwd = stringOption(ctx, 'cwd');
    const loaded = await loadCliConfig(ctx.io, ctx.configPath);
    const { runtime } = compose(loaded, ctx.io, ctx.logger);
    const task = await buildTask(runtime.nexar, ctx, cwd === undefined ? {} : { cwd });

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
