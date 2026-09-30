import {
  NexarError,
  type AdapterId,
  type ExecutionAdapter,
  type ResourceDescriptor,
} from '@nexar/contracts';

/** Holds the installed execution adapters and picks the one that runs a resource. */
export class AdapterRegistry {
  private readonly adapters = new Map<AdapterId, ExecutionAdapter>();

  register(adapter: ExecutionAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new NexarError('CONFIGURATION_ERROR', `Adapter already registered: ${adapter.id}`, {
        details: { adapterId: adapter.id },
      });
    }
    this.adapters.set(adapter.id, adapter);
  }

  get(id: AdapterId): ExecutionAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): readonly ExecutionAdapter[] {
    return [...this.adapters.values()];
  }

  /** The adapter bound by `descriptor.runtime.adapter`, provided it supports the resource. */
  resolve(descriptor: ResourceDescriptor): ExecutionAdapter {
    const wanted = descriptor.runtime.adapter;
    const adapter = this.adapters.get(wanted);
    if (adapter === undefined) {
      throw new NexarError(
        'ADAPTER_NOT_FOUND',
        `Adapter "${wanted}" is not installed (resource ${descriptor.id})`,
        { details: { adapterId: wanted, resourceId: descriptor.id } },
      );
    }
    if (!adapter.supports(descriptor)) {
      throw new NexarError(
        'ADAPTER_NOT_FOUND',
        `Adapter "${wanted}" does not support resource ${descriptor.id}`,
        { details: { adapterId: wanted, resourceId: descriptor.id } },
      );
    }
    return adapter;
  }
}
