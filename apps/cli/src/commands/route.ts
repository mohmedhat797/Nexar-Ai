import {
  estimateTaskSize,
  explainRouteDecision,
  explainRouteDecisionDetailed,
  laneRoleOf,
} from '@nexar/resource-controller';
import { TASK_OPTIONS, buildTask, flagOption, type Command } from '../args.js';
import { compose, loadCliConfig } from '../composition.js';
import { EXIT } from '../io.js';

export const routeCommand: Command = {
  name: 'route',
  summary: 'Explain which resource would run a task (no execution)',
  usage:
    'nexar route --kind <kind> [--capability <c>]... [--prefer <id>]... [--exclude <id>]... [--local-only]\n' +
    '           [--max-cost <usd>] [--require-known-quota] [--project <id>] [--explain] [--json] <prompt...>',
  options: { ...TASK_OPTIONS, explain: { type: 'boolean' } },
  async run(ctx) {
    const loaded = await loadCliConfig(ctx.io, ctx.configPath);
    const { runtime, historySource } = await compose(loaded, ctx.io, ctx.logger);
    const task = await buildTask(runtime.nexar, ctx);
    const decision = await runtime.nexar.route(task);
    if (ctx.json) {
      ctx.io.stdout(JSON.stringify(decision, null, 2) + '\n');
    } else if (flagOption(ctx, 'explain')) {
      const laneRole = laneRoleOf(task);
      // Only window bounds and the skipped count are shown; the aggregates stay internal.
      const history = await historySource.read(new Date(decision.decidedAt));
      ctx.io.stdout(
        explainRouteDecisionDetailed(decision, {
          size: estimateTaskSize(task),
          ...(laneRole === undefined ? {} : { laneRole }),
          ...(history === undefined
            ? {}
            : {
                history: {
                  windowStart: history.windowStart,
                  windowEnd: history.windowEnd,
                  skipped: history.skipped,
                },
              }),
        }) + '\n',
      );
    } else {
      ctx.io.stdout(explainRouteDecision(decision) + '\n');
    }
    return decision.outcome === 'selected' ? EXIT.ok : EXIT.noEligibleResource;
  },
};
