import { explainRouteDecision } from '@nexar/resource-controller';
import { TASK_OPTIONS, buildTask, type Command } from '../args.js';
import { compose, loadCliConfig } from '../composition.js';
import { EXIT } from '../io.js';

export const routeCommand: Command = {
  name: 'route',
  summary: 'Explain which resource would run a task (no execution)',
  usage:
    'nexar route --kind <kind> [--capability <c>]... [--prefer <id>]... [--exclude <id>]... [--local-only] [--json] <prompt...>',
  options: TASK_OPTIONS,
  async run(ctx) {
    const loaded = await loadCliConfig(ctx.io, ctx.configPath);
    const { runtime } = compose(loaded, ctx.io, ctx.logger);
    const task = await buildTask(runtime.nexar, ctx);
    const decision = await runtime.nexar.route(task);
    ctx.io.stdout(
      ctx.json ? JSON.stringify(decision, null, 2) + '\n' : explainRouteDecision(decision) + '\n',
    );
    return decision.outcome === 'selected' ? EXIT.ok : EXIT.noEligibleResource;
  },
};
