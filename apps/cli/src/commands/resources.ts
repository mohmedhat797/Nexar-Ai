import type { ResourceDescriptor, ResourceSnapshot } from '@nexar/contracts';
import { flagOption, type Command } from '../args.js';
import { compose, loadCliConfig } from '../composition.js';
import { renderTable } from '../format.js';
import { EXIT } from '../io.js';

/** `agent:claude-code`, `model:anthropic/claude-sonnet-4-5`, `tool-runtime:<tool>`. */
export function describeKind(kind: ResourceDescriptor['kind']): string {
  switch (kind.type) {
    case 'model':
      return `model:${kind.provider}/${kind.model}`;
    case 'agent':
      return `agent:${kind.agent}`;
    case 'tool-runtime':
      return `tool-runtime:${kind.tool}`;
  }
}

function toRow(snapshot: ResourceSnapshot): Record<string, unknown> {
  const { descriptor, state } = snapshot;
  return {
    id: descriptor.id,
    kind: describeKind(descriptor.kind),
    adapter: descriptor.runtime.adapter,
    availability: state.availability,
    auth: state.auth,
    capabilities: descriptor.capabilities,
    ...(state.detail === undefined ? {} : { detail: state.detail }),
  };
}

export const resourcesCommand: Command = {
  name: 'resources',
  summary: 'List configured resources and their probed state',
  usage: 'nexar resources [--json] [--no-refresh]',
  options: { 'no-refresh': { type: 'boolean' } },
  async run(ctx) {
    const loaded = await loadCliConfig(ctx.io, ctx.configPath);
    const { runtime } = await compose(loaded, ctx.io, ctx.logger);
    const snapshots = flagOption(ctx, 'no-refresh')
      ? runtime.registry.snapshot()
      : await runtime.registry.refresh();
    const rows = snapshots.map(toRow);
    if (ctx.json) {
      ctx.io.stdout(JSON.stringify(rows, null, 2) + '\n');
      return EXIT.ok;
    }
    const table = renderTable(
      ['ID', 'KIND', 'ADAPTER', 'AVAILABILITY', 'AUTH', 'CAPABILITIES'],
      rows.map((r) => [
        String(r['id']),
        String(r['kind']),
        String(r['adapter']),
        String(r['availability']),
        String(r['auth']),
        (r['capabilities'] as readonly string[]).join(','),
      ]),
    );
    ctx.io.stdout(table + '\n');
    return EXIT.ok;
  },
};
