import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNexarError, resourceId, type ResourceId } from '@nexar/contracts';
import { explainRouteDecision } from '@nexar/resource-controller';
import type { WorkflowCatalog, WorkflowInputValues } from '@nexar/workflows';
import { flagOption, listOption, stringOption, type CommandContext } from '../args.js';
import { compose, composeWorkflows, loadCliConfig } from '../composition.js';
import { formatMeasured } from '../format.js';
import { EXIT, UsageError } from '../io.js';

/** An `--input-file` may not be larger than this; it is passed to the model as input text. */
export const MAX_INPUT_FILE_BYTES = 100 * 1024;

function assignment(raw: string, flag: string): [string, string] {
  const at = raw.indexOf('=');
  if (at <= 0) throw new UsageError(`${flag} expects name=value`);
  return [raw.slice(0, at), raw.slice(at + 1)];
}

function toResourceId(raw: string): ResourceId {
  try {
    return resourceId(raw);
  } catch {
    throw new UsageError(`invalid resource id "${raw}"`);
  }
}

/** Collects `--input`, `--input-file` and `--list-input`; each name may be given only once. */
async function readInputs(
  ctx: CommandContext,
  catalog: WorkflowCatalog,
  workflowId: string,
  projectId: string,
): Promise<WorkflowInputValues> {
  const values: Record<string, string | string[]> = {};
  const set = (name: string, value: string | string[]): void => {
    if (Object.hasOwn(values, name))
      throw new UsageError(`input "${name}" is given more than once`);
    values[name] = value;
  };
  for (const raw of listOption(ctx, 'input')) set(...assignment(raw, '--input'));
  for (const raw of listOption(ctx, 'list-input')) {
    const [name, value] = assignment(raw, '--list-input');
    set(
      name,
      value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== ''),
    );
  }
  const declared = catalog.get(workflowId, projectId)?.definition.inputs;
  for (const raw of listOption(ctx, 'input-file')) {
    const [name, path] = assignment(raw, '--input-file');
    const file = resolve(ctx.io.cwd, path);
    let text: string;
    try {
      if ((await stat(file)).size > MAX_INPUT_FILE_BYTES) throw new RangeError('too large');
      text = await readFile(file, 'utf8');
    } catch (error) {
      const why = error instanceof RangeError ? 'is larger than 100 KB' : 'cannot be read';
      throw new UsageError(`--input-file for "${name}": the file ${why}`);
    }
    if (Buffer.byteLength(text) > MAX_INPUT_FILE_BYTES) {
      throw new UsageError(`--input-file for "${name}": the file is larger than 100 KB`);
    }
    text = text.replace(/\r?\n$/, '');
    // The file is still untrusted input text: it only ever reaches the prompt inside the wrapper.
    const isList = declared?.find((i) => i.name === name)?.type === 'list';
    set(name, isList ? text.split(/\r?\n/).filter((l) => l.trim() !== '') : text);
  }
  return values;
}

/** `nexar run --workflow <id> --project <id> …`: validates, runs, prints the artifact paths. */
export async function runWorkflow(
  ctx: CommandContext,
  timeoutMs: number | undefined,
): Promise<number> {
  const workflowId = stringOption(ctx, 'workflow') ?? '';
  const project = stringOption(ctx, 'project');
  if (project === undefined || project === '') {
    throw new UsageError('--workflow requires --project <id>');
  }
  const conflicts = [
    ['--kind', stringOption(ctx, 'kind') !== undefined],
    ['--cwd', stringOption(ctx, 'cwd') !== undefined],
    ['--document-set', listOption(ctx, 'document-set').length > 0],
    ['a prompt', ctx.positionals.length > 0],
  ] as const;
  for (const [name, present] of conflicts) {
    if (present) throw new UsageError(`${name} cannot be combined with --workflow`);
  }
  const quiet = flagOption(ctx, 'quiet');

  const loaded = await loadCliConfig(ctx.io, ctx.configPath);
  const { runtime } = await compose(loaded, ctx.io, ctx.logger);
  const { catalog, runner } = await composeWorkflows(runtime, ctx.io);
  const inputs = await readInputs(ctx, catalog, workflowId, project);
  const preferred = listOption(ctx, 'prefer').map(toResourceId);
  const excluded = listOption(ctx, 'exclude').map(toResourceId);

  let prepared;
  try {
    prepared = await runner.prepare({
      workflowId,
      projectId: project,
      inputs,
      origin: { source: 'cli', project },
      requirements: {
        capabilities: listOption(ctx, 'capability'),
        ...(preferred.length === 0 ? {} : { preferredResourceIds: preferred }),
        ...(excluded.length === 0 ? {} : { excludedResourceIds: excluded }),
        ...(flagOption(ctx, 'local-only') ? { privacy: 'local-only' as const } : {}),
      },
    });
  } catch (error) {
    // Bad input is reported with every problem, before any resource is involved. Exit code 2,
    // like other command-line mistakes.
    const issues = isNexarError(error) ? error.details?.['issues'] : undefined;
    if (isNexarError(error) && error.code === 'VALIDATION_ERROR' && Array.isArray(issues)) {
      ctx.io.stderr(`error [VALIDATION_ERROR]: invalid workflow inputs\n`);
      for (const issue of issues as { input: string; problem: string }[]) {
        ctx.io.stderr(`  - ${issue.input}: ${issue.problem}\n`);
      }
      return EXIT.usage;
    }
    throw error;
  }

  const abort = new AbortController();
  const onSigint = (): void => abort.abort(new Error('interrupted (SIGINT)'));
  process.once('SIGINT', onSigint);
  try {
    const run = await runner.run(prepared, {
      signal: abort.signal,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      onEvent: (event) => {
        if (!quiet && event.type === 'status') ctx.io.stderr(`[event] ${event.message}\n`);
      },
    });
    const { decision, record, artifacts } = run;
    if (!quiet) ctx.io.stderr(explainRouteDecision(decision) + '\n');
    if (ctx.json) {
      ctx.io.stdout(
        JSON.stringify(
          {
            workflow: workflowId,
            project,
            taskId: run.outcome.task.id,
            outputsSplit: run.outputsSplit,
            artifacts,
            decision,
            record,
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      for (const ref of artifacts) {
        ctx.io.stdout(`${fileURLToPath(ref.uri)}${ref.draft === true ? '  (draft)' : ''}\n`);
      }
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
}
