import { randomUUID } from 'node:crypto';
import { NexarError } from '@nexar/contracts';
import { z } from 'zod';
import {
  EndpointInputSchema,
  EndpointListSchema,
  EndpointRemoveSchema,
  EndpointSaveSchema,
  EndpointUrlSchema,
  type LocalEndpointInput,
  type LocalEndpointRow,
} from '../shared/local-endpoints.js';
import { CHANNELS } from '../shared/channels.js';
import { NoArgs, defineChannel, type ChannelDefinition } from './channel.js';
import type { ConfigStore, RawConfig } from './config-store.js';
import type { EngineHost } from './engine-host.js';

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function endpoints(raw: RawConfig): z.output<typeof EndpointInputSchema>[] {
  return z
    .array(EndpointInputSchema)
    .max(32)
    .parse(object(object(object(raw.discovery).sources).localEndpoints).endpoints ?? []);
}

/** Owner-listed keyless servers; config writes, rediscovery and rollback share the config queue. */
export class LocalEndpointService {
  constructor(
    private readonly config: ConfigStore,
    private readonly engine: EngineHost,
  ) {}

  async list(): Promise<readonly LocalEndpointRow[]> {
    return this.rows(await this.config.read());
  }

  async save(input: LocalEndpointInput): Promise<readonly LocalEndpointRow[]> {
    const validated = EndpointSaveSchema.parse(input);
    const baseUrl = EndpointUrlSchema.parse(
      new URL(validated.baseUrl).toString().replace(/\/+$/, ''),
    );
    await this.config.update(
      (raw) => {
        const existing = endpoints(raw);
        if (validated.id !== undefined && !existing.some((entry) => entry.id === validated.id))
          throw new NexarError('VALIDATION_ERROR', 'Unknown server');
        if (validated.id === undefined && existing.length >= 32)
          throw new NexarError('VALIDATION_ERROR', 'Server limit reached');
        const id = validated.id ?? `server-${randomUUID().slice(0, 20)}`;
        if (validated.id === undefined && existing.some((entry) => entry.id === id))
          throw new NexarError('CONFLICT', 'Server id collision');
        const entry = EndpointInputSchema.parse({ id, kind: validated.kind, baseUrl });
        const updated =
          validated.id === undefined
            ? [...existing, entry]
            : existing.map((current) => (current.id === id ? entry : current));
        this.write(raw, updated, true);
      },
      () => this.engine.reload(),
    );
    return this.list();
  }

  async remove(id: string): Promise<readonly LocalEndpointRow[]> {
    EndpointRemoveSchema.parse({ id });
    await this.config.update(
      (raw) => {
        const existing = endpoints(raw);
        if (!existing.some((entry) => entry.id === id))
          throw new NexarError('VALIDATION_ERROR', 'Unknown server');
        this.write(
          raw,
          existing.filter((entry) => entry.id !== id),
          false,
        );
      },
      () => this.engine.reload(),
    );
    return this.list();
  }

  async refresh(): Promise<readonly LocalEndpointRow[]> {
    // Composition reruns discovery; registry.refresh only probes the already discovered descriptors.
    await this.config.update(
      () => undefined,
      () => this.engine.reload(),
    );
    return this.list();
  }

  private write(
    raw: RawConfig,
    entries: z.output<typeof EndpointInputSchema>[],
    enable: boolean,
  ): void {
    const discovery = object(raw.discovery);
    const sources = object(discovery.sources);
    raw.discovery = {
      ...discovery,
      ...(enable ? { enabled: true } : {}),
      sources: {
        ...sources,
        localEndpoints: {
          ...object(sources.localEndpoints),
          ...(enable ? { enabled: true } : {}),
          endpoints: entries,
        },
      },
    };
  }

  private rows(raw: RawConfig): readonly LocalEndpointRow[] {
    const discovery = object(raw.discovery);
    const local = object(object(discovery.sources).localEndpoints);
    const snapshots = this.engine.composition().runtime.registry.snapshot();
    return EndpointListSchema.parse(
      endpoints(raw).map((entry) => ({
        ...entry,
        enabled: discovery.enabled === true && local.enabled !== false,
        modelCount: snapshots.filter(
          ({ descriptor }) =>
            descriptor.provenance === 'discovered:local-endpoints' &&
            descriptor.kind.type === 'model' &&
            descriptor.kind.provider === entry.id,
        ).length,
      })),
    );
  }
}

function service(value: LocalEndpointService | undefined): LocalEndpointService {
  if (!value) throw new NexarError('CONFIGURATION_ERROR', 'Local endpoint setup unavailable');
  return value;
}
export const localEndpointChannels: Readonly<Record<string, ChannelDefinition>> = {
  [CHANNELS.endpointsList]: defineChannel(NoArgs, (_args, { deps }) =>
    service(deps.localEndpoints).list(),
  ),
  [CHANNELS.endpointsSave]: defineChannel(EndpointSaveSchema, (input, { deps }) =>
    service(deps.localEndpoints).save(input),
  ),
  [CHANNELS.endpointsRemove]: defineChannel(EndpointRemoveSchema, ({ id }, { deps }) =>
    service(deps.localEndpoints).remove(id),
  ),
  [CHANNELS.endpointsRefresh]: defineChannel(NoArgs, (_args, { deps }) =>
    service(deps.localEndpoints).refresh(),
  ),
};
