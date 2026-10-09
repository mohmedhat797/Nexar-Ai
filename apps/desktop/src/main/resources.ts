import { z } from 'zod';
import {
  connectionOf,
  isControlCompatible,
  type ResourceDescriptor,
  type ResourceSnapshot,
} from '@nexar/contracts';
import { assessQuota } from '@nexar/resource-controller';
import type { ResourceRow } from '../shared/api.js';
import { CHANNELS } from '../shared/channels.js';
import { defineChannel, type CallContext, type ChannelDefinition } from './channel.js';

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

function toRow(snapshot: ResourceSnapshot, quota: ResourceRow['quota']): ResourceRow {
  const { descriptor, state } = snapshot;
  const connection = connectionOf(descriptor);
  return {
    id: descriptor.id,
    displayName: descriptor.displayName,
    kind: describeKind(descriptor.kind),
    adapter: descriptor.runtime.adapter,
    provenance: descriptor.provenance ?? 'configured',
    availability: state.availability,
    auth: state.auth,
    quota,
    costModel: descriptor.cost.model,
    capabilities: descriptor.capabilities,
    ...(state.detail === undefined ? {} : { detail: state.detail }),
    ...(connection === undefined
      ? {}
      : {
          connection: {
            provider: connection.provider,
            method: connection.method,
            support: connection.support,
          },
        }),
    control: {
      openworker: isControlCompatible(descriptor, 'openworker'),
      dsh: isControlCompatible(descriptor, 'dsh'),
    },
  };
}

/** The rows `nexar resources --json` prints, plus the display name and pricing model. */
async function listResources(ctx: CallContext, refresh: boolean): Promise<readonly ResourceRow[]> {
  const { engine } = ctx.deps;
  const snapshots = await engine.snapshots(refresh);
  const { loaded, quotaSource } = engine.composition();
  const now = new Date();
  const settings = loaded.config.routing.resourceIntelligence.quota;
  // A failing or absent source leaves quota unknown, as in routing.
  const observed = await (
    quotaSource?.observe(
      snapshots.map((s) => s.descriptor.id),
      now,
    ) ?? Promise.resolve(undefined)
  ).catch(() => undefined);
  return snapshots.map((s) => toRow(s, assessQuota(observed?.get(s.descriptor.id), now, settings)));
}

export const resourceChannels: Readonly<Record<string, ChannelDefinition>> = {
  [CHANNELS.resourcesList]: defineChannel(
    z.strictObject({ refresh: z.boolean().optional() }),
    (a, ctx) => listResources(ctx, a.refresh === true),
  ),
};
