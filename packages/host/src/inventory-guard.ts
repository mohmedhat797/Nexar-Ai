import {
  NexarError,
  isNexarError,
  type ExecutionAdapter,
  type ResourceDescriptor,
} from '@nexar/contracts';

export interface InventoryExecutionGuard {
  readonly isAvailable: (descriptor: ResourceDescriptor) => boolean;
  readonly onModelRejected: (descriptor: ResourceDescriptor) => void;
}

/** Inventory metadata is checked again at execution, since a probed registry snapshot can expire. */
export function guardInventoryAdapter(
  adapter: ExecutionAdapter,
  guard: InventoryExecutionGuard,
): ExecutionAdapter {
  const guarded = (resource: ResourceDescriptor): boolean =>
    resource.metadata?.['inventory'] !== undefined;
  const available = (resource: ResourceDescriptor): boolean =>
    !guarded(resource) || guard.isAvailable(resource);
  const stale = () => ({
    availability: 'unavailable' as const,
    auth: 'unknown' as const,
    detail: 'Model inventory is not current',
    observedAt: new Date().toISOString(),
  });
  return {
    id: adapter.id,
    displayName: adapter.displayName,
    supports: (resource) => adapter.supports(resource),
    async probe(resource, signal) {
      if (!available(resource)) return stale();
      const state = await adapter.probe(resource, signal);
      return available(resource) ? state : stale();
    },
    async execute(request, context) {
      if (!available(request.resource))
        throw new NexarError('RESOURCE_UNAVAILABLE', 'Model inventory is not current', {
          retryable: false,
          details: { reason: 'inventory-stale' },
        });
      try {
        return await adapter.execute(request, context);
      } catch (error) {
        if (
          guarded(request.resource) &&
          request.resource.kind.type === 'agent' &&
          isNexarError(error) &&
          error.details?.['reason'] === 'model-rejected'
        ) {
          guard.onModelRejected(request.resource);
        }
        throw error;
      }
    },
  };
}
