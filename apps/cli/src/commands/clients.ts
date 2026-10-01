import { ClientRegistry, type ClientScopes, type PublicClient } from '@nexar/access';
import { NEXAR_MCP_TOOLS } from '@nexar/integration-mcp';
import { stringOption, type Command, type CommandContext } from '../args.js';
import { clientsFilePath, loadCliConfig } from '../composition.js';
import { renderTable } from '../format.js';
import { EXIT, UsageError } from '../io.js';

const USAGE = [
  'nexar clients add <id> --tools <t,...> --task-kinds <k,...> --projects <p,...>',
  '                       [--workflows <w,...>] [--max-cost <usd>] [--json]',
  'nexar clients list [--json]',
  'nexar clients revoke <id>',
].join('\n       ');

/** `*` in a list means "any". */
function csv(ctx: CommandContext, name: string, required: boolean): string[] {
  const raw = stringOption(ctx, name);
  if (raw === undefined) {
    if (required) throw new UsageError(`--${name} <list> is required`);
    return [];
  }
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (items.length === 0) throw new UsageError(`--${name} must not be empty`);
  return [...new Set(items)];
}

function parseScopes(ctx: CommandContext): ClientScopes {
  const tools = csv(ctx, 'tools', true);
  const unknown = tools.filter(
    (t) => t !== '*' && !(NEXAR_MCP_TOOLS as readonly string[]).includes(t),
  );
  if (unknown.length > 0) {
    throw new UsageError(
      `unknown tool ${unknown.map((t) => `"${t}"`).join(', ')} (known: ${NEXAR_MCP_TOOLS.join(', ')})`,
    );
  }
  const rawCost = stringOption(ctx, 'max-cost');
  let maxCostUsd: number | undefined;
  if (rawCost !== undefined) {
    maxCostUsd = Number(rawCost);
    if (rawCost.trim() === '' || !Number.isFinite(maxCostUsd) || maxCostUsd < 0) {
      throw new UsageError(`--max-cost must be a non-negative number (USD), got "${rawCost}"`);
    }
  }
  return {
    tools,
    taskKinds: csv(ctx, 'task-kinds', true),
    projects: csv(ctx, 'projects', true),
    workflows: csv(ctx, 'workflows', false),
    ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
  };
}

function toRow(client: PublicClient): string[] {
  const list = (items: readonly string[]): string => (items.length === 0 ? '-' : items.join(','));
  return [
    client.id,
    client.revokedAt === undefined ? 'active' : 'revoked',
    client.createdAt,
    `…${client.tokenHint}`,
    list(client.scopes.tools),
    list(client.scopes.taskKinds),
    list(client.scopes.projects),
    list(client.scopes.workflows),
    client.scopes.maxCostUsd === undefined ? '-' : String(client.scopes.maxCostUsd),
  ];
}

export const clientsCommand: Command = {
  name: 'clients',
  summary: 'Create, list and revoke scoped client credentials for the MCP server',
  usage: USAGE,
  options: {
    tools: { type: 'string' },
    'task-kinds': { type: 'string' },
    projects: { type: 'string' },
    workflows: { type: 'string' },
    'max-cost': { type: 'string' },
  },
  async run(ctx) {
    const [action, id, ...extra] = ctx.positionals;
    const loaded = await loadCliConfig(ctx.io, ctx.configPath);
    const registry = await ClientRegistry.open(clientsFilePath(loaded, ctx.io));

    if (action === 'list' && id === undefined) {
      const clients = registry.list();
      if (ctx.json) ctx.io.stdout(JSON.stringify(clients, null, 2) + '\n');
      else if (clients.length === 0) ctx.io.stdout('no clients\n');
      else {
        ctx.io.stdout(
          renderTable(
            [
              'ID',
              'STATUS',
              'CREATED',
              'TOKEN',
              'TOOLS',
              'TASK KINDS',
              'PROJECTS',
              'WORKFLOWS',
              'MAX COST',
            ],
            clients.map(toRow),
          ) + '\n',
        );
      }
      return EXIT.ok;
    }

    if (action === 'add' && id !== undefined && extra.length === 0) {
      const { client, token } = await registry.add(id, parseScopes(ctx));
      // The token is shown once, on stdout alone so `TOKEN=$(nexar clients add ...)` captures it.
      ctx.io.stderr(
        `client "${client.id}" created. Store the token now: it is not stored in plain text and will not be shown again.\n`,
      );
      ctx.io.stdout(ctx.json ? JSON.stringify({ client, token }, null, 2) + '\n' : token + '\n');
      return EXIT.ok;
    }

    if (action === 'revoke' && id !== undefined && extra.length === 0) {
      const client = await registry.revoke(id);
      ctx.io.stdout(ctx.json ? JSON.stringify(client, null, 2) + '\n' : `revoked ${client.id}\n`);
      return EXIT.ok;
    }

    throw new UsageError(`usage: ${USAGE}`);
  },
};
