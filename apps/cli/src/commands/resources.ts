import type { QuotaAssessment, ResourceDescriptor, ResourceSnapshot } from '@nexar/contracts';
import { assessQuota } from '@nexar/resource-controller';
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

/** `2026-10-02T00:00Z`: minute precision is enough for a reset time. */
function shortTime(iso: string): string {
  return iso.replace(/:\d{2}(\.\d+)?Z$/, 'Z');
}

/**
 * `unknown`, `stale`, `62% left · resets 2026-10-02T00:00Z · owner-declared+nexar-accounting` or
 * `exhausted until …`. Only the assessment's computed fields are shown: never labels or identifiers.
 */
export function describeQuota(a: QuotaAssessment): string {
  const resets = a.resetsAt === undefined ? [] : [`resets ${shortTime(a.resetsAt)}`];
  const source = a.sources.length === 0 ? [] : [a.sources.join(',')];
  switch (a.freshness) {
    case 'unknown':
      return 'unknown';
    case 'known-stale':
      return 'stale';
    case 'exhausted':
      return a.resetsAt === undefined ? 'exhausted' : `exhausted until ${shortTime(a.resetsAt)}`;
    case 'known-current':
      return [`${Math.round((a.headroom ?? 0) * 100)}% left`, ...resets, ...source].join(' · ');
  }
}

function toRow(snapshot: ResourceSnapshot, quota: QuotaAssessment): Record<string, unknown> {
  const { descriptor, state } = snapshot;
  return {
    id: descriptor.id,
    kind: describeKind(descriptor.kind),
    adapter: descriptor.runtime.adapter,
    availability: state.availability,
    auth: state.auth,
    capabilities: descriptor.capabilities,
    quota,
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
    const { runtime, quotaSource } = await compose(loaded, ctx.io, ctx.logger);
    const snapshots = flagOption(ctx, 'no-refresh')
      ? runtime.registry.snapshot()
      : await runtime.registry.refresh();
    const now = new Date();
    const settings = loaded.config.routing.resourceIntelligence.quota;
    // A failing or absent source leaves quota unknown, as in routing.
    const observed = await (
      quotaSource?.observe(
        snapshots.map((s) => s.descriptor.id),
        now,
      ) ?? Promise.resolve(undefined)
    ).catch(() => undefined);
    const rows = snapshots.map((s) =>
      toRow(s, assessQuota(observed?.get(s.descriptor.id), now, settings)),
    );
    if (ctx.json) {
      ctx.io.stdout(JSON.stringify(rows, null, 2) + '\n');
      return EXIT.ok;
    }
    const table = renderTable(
      ['ID', 'KIND', 'ADAPTER', 'AVAILABILITY', 'AUTH', 'QUOTA', 'CAPABILITIES'],
      rows.map((r) => [
        String(r['id']),
        String(r['kind']),
        String(r['adapter']),
        String(r['availability']),
        String(r['auth']),
        describeQuota(r['quota'] as QuotaAssessment),
        (r['capabilities'] as readonly string[]).join(','),
      ]),
    );
    ctx.io.stdout(table + '\n');
    return EXIT.ok;
  },
};
