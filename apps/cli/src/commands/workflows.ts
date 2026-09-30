import { stringOption, type Command } from '../args.js';
import { compose, composeWorkflows, loadCliConfig } from '../composition.js';
import { EXIT, UsageError } from '../io.js';

const USAGE = 'nexar workflows list [--project <id>] [--json]';

export const workflowsCommand: Command = {
  name: 'workflows',
  summary: 'List the available workflows (run one with "nexar run --workflow")',
  usage:
    `${USAGE}\n\nWith --project, that project's own workflows are included and override built-ins ` +
    'with the same id.',
  options: { project: { type: 'string' } },
  async run(ctx) {
    if (ctx.positionals.length !== 1 || ctx.positionals[0] !== 'list') {
      throw new UsageError(`usage: ${USAGE}`);
    }
    const loaded = await loadCliConfig(ctx.io, ctx.configPath);
    const { runtime } = await compose(loaded, ctx.io, ctx.logger);
    const { catalog } = await composeWorkflows(runtime, ctx.io);
    const workflows = catalog.list(stringOption(ctx, 'project')).map((w) => w.summary);

    if (ctx.json) {
      ctx.io.stdout(JSON.stringify(workflows, null, 2) + '\n');
      return EXIT.ok;
    }
    if (workflows.length === 0) {
      ctx.io.stdout('no workflows\n');
      return EXIT.ok;
    }
    const blocks = workflows.map((w) =>
      [
        `${w.id}  ${w.displayName}  (${w.taskKind}, ${w.source})`,
        `  ${w.description}`,
        `  inputs:  ${w.inputs.map((i) => `${i.name}${i.required ? '*' : ''} (${i.type})`).join(', ')}`,
        `  outputs: ${w.outputs.map((o) => `${o.id} (${o.mediaType}${o.draft ? ', draft' : ''})`).join(', ')}`,
      ].join('\n'),
    );
    ctx.io.stdout(blocks.join('\n\n') + '\n\n* required\n');
    return EXIT.ok;
  },
};
