import { resolve } from 'node:path';
import type {
  ExecutionAdapter,
  Logger,
  ResourceDescriptor,
  ResourceState,
  TelemetrySink,
} from '@nexar/contracts';
import { DeterministicRoutingPolicy, ResourceController } from '@nexar/resource-controller';
import { InMemoryResourceRegistry, type ResourceProbe } from '@nexar/resource-registry';
import { CompositeTelemetrySink, JsonlFileTelemetrySink, noopLogger } from '@nexar/telemetry';
import { AdapterRegistry } from './adapter-registry.js';
import type { NexarConfig } from './config.js';
import { Nexar } from './engine.js';

export interface CreateNexarOptions {
  readonly adapters: readonly ExecutionAdapter[];
  readonly logger?: Logger;
  /** Extra sink, used alongside the JSONL file sink when the config enables one. */
  readonly telemetry?: TelemetrySink;
  /** Directory that relative config paths (e.g. `telemetry.jsonlPath`) resolve against. */
  readonly configDir?: string;
}

export interface NexarRuntime {
  readonly nexar: Nexar;
  readonly registry: InMemoryResourceRegistry;
  readonly adapters: AdapterRegistry;
  readonly controller: ResourceController;
}

const discardSink: TelemetrySink = { emit: () => undefined };

/** Wires config + adapters into a ready engine. */
export function createNexar(config: NexarConfig, options: CreateNexarOptions): NexarRuntime {
  const logger = options.logger ?? noopLogger;
  const adapters = new AdapterRegistry();
  for (const adapter of options.adapters) adapters.register(adapter);

  const registry = new InMemoryResourceRegistry();
  for (const descriptor of config.resources) {
    registry.register(descriptor, { probe: probeFor(descriptor, adapters) });
  }

  const policy = new DeterministicRoutingPolicy({
    taskKinds: config.routing.taskKinds,
    ...(config.routing.defaultResourceId === undefined
      ? {}
      : { defaultResourceId: config.routing.defaultResourceId }),
  });
  const controller = new ResourceController({ registry, policy, refreshBeforeRouting: true });

  const sinks: TelemetrySink[] = [];
  if (options.telemetry !== undefined) sinks.push(options.telemetry);
  if (config.telemetry.jsonlPath !== undefined) {
    sinks.push(
      new JsonlFileTelemetrySink(
        resolve(options.configDir ?? process.cwd(), config.telemetry.jsonlPath),
      ),
    );
  }
  const telemetry =
    sinks.length === 0
      ? discardSink
      : new CompositeTelemetrySink(sinks, (error) =>
          logger.warn('telemetry sink failed', {
            error: error instanceof Error ? error.message : String(error),
          }),
        );

  const nexar = new Nexar({ registry, router: controller, adapters, telemetry, logger });
  return { nexar, registry, adapters, controller };
}

function probeFor(descriptor: ResourceDescriptor, adapters: AdapterRegistry): ResourceProbe {
  const adapterId = descriptor.runtime.adapter;
  const installed = adapters.get(adapterId);
  if (installed === undefined || !installed.supports(descriptor)) {
    const detail =
      installed === undefined
        ? `adapter "${adapterId}" not installed`
        : `adapter "${adapterId}" does not support this resource`;
    return (): Promise<ResourceState> =>
      Promise.resolve({
        availability: 'unavailable',
        auth: 'unknown',
        detail,
        observedAt: new Date().toISOString(),
      });
  }
  return (d, signal) => installed.probe(d, signal);
}
