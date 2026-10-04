import type { NexarRuntime } from '@nexar/core';
import type { BridgeAllocator, ChildExecutor } from '@nexar/engine-gateway';

/** The part of a composition the bridge ports need: the engine and its resource controller. */
export interface BridgeRuntimeSource {
  composition(): { readonly runtime: Pick<NexarRuntime, 'nexar' | 'controller'> };
}

/**
 * The child executor over the Nexar engine: `createTask` + `run`, no engineering workspace, under
 * the host's workspace policy. Lineage reaches the task as metadata (ids only).
 */
export function createEngineExecutor(source: BridgeRuntimeSource): ChildExecutor {
  return async (input, signal) => {
    const { nexar } = source.composition().runtime;
    const task = nexar.createTask({
      kind: input.kind,
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
      projectId: input.projectId,
      origin: input.origin,
      requirements: input.requirements,
      metadata: { ...input.metadata },
    });
    const outcome = await nexar.run(task, { signal });
    return {
      text: outcome.result.text,
      usage: outcome.record.usage,
      resourceId: outcome.record.resourceId,
    };
  };
}

/** The allocator a bridge host gets: the engine's own resource controller. */
export function engineAllocator(source: BridgeRuntimeSource): BridgeAllocator {
  return {
    allocate: (ledger, unit, settings) =>
      source.composition().runtime.controller.allocate(ledger, unit, settings),
  };
}
