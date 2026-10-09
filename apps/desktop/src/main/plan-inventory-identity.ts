import type { ProviderRuntimeIdentity } from '@nexar/contracts';
import { inventoryResourceId } from '@nexar/resource-registry';

export const PLAN_INVENTORY_IDENTITY: ProviderRuntimeIdentity = {
  provider: 'openai',
  connectionId: 'openai.chatgpt-plan',
  runtimeId: 'pi',
  routeId: 'openai.responses.account',
  machine: 'desktop',
};

/** Resolve old Desktop pins for this immutable route without rewriting the owner's raw settings. */
export function migratePlanResourceId(id: string): string {
  const match = /^chatgpt-plan:([a-z0-9][a-z0-9._-]{0,63})$/.exec(id);
  return match?.[1] === undefined
    ? id
    : inventoryResourceId(PLAN_INVENTORY_IDENTITY, { kind: 'model', id: match[1] });
}
