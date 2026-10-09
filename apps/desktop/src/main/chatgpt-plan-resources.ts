import { chatGptPlanModelResource } from '@nexar/host';
import { isNexarError } from '@nexar/contracts';
import { createOpenAiAccountModelClient } from '@nexar/integration-openai-account';
import type { ChatGptPlanService } from './chatgpt-plan.js';
import type { InventoryDefinition } from './provider-inventory.js';
import { PLAN_INVENTORY_IDENTITY } from './plan-inventory-identity.js';

/** Account Responses listing is distinct from native Codex and API-key catalogs. */
export function chatGptPlanInventoryDefinition(
  plan: Pick<ChatGptPlanService, 'status' | 'accessToken'>,
  options: { readonly fetch?: typeof fetch } = {},
): InventoryDefinition {
  const client = createOpenAiAccountModelClient(options);
  return {
    sourceId: 'chatgpt-plan',
    identity: PLAN_INVENTORY_IDENTITY,
    source: {
      async fetch(signal) {
        const status = await plan.status();
        if (status.state !== 'connected' || status.planSharing !== true) {
          return {
            status: 'unavailable',
            source: 'official-api',
            auth: 'unauthenticated',
            reason: 'not-connected',
          };
        }
        const token = await plan.accessToken();
        signal.throwIfAborted();
        const active = await plan.status();
        if (active.state !== 'connected' || active.planSharing !== true)
          return {
            status: 'unavailable',
            source: 'official-api',
            auth: 'unauthenticated',
            reason: 'not-connected',
          };
        let models;
        try {
          models = await client.listModels({ accessToken: token, signal });
        } catch (error) {
          if (!isNexarError(error) || error.code !== 'AUTH_REQUIRED' || signal.aborted) throw error;
          const refreshed = await plan.accessToken({ refresh: true });
          signal.throwIfAborted();
          const active = await plan.status();
          if (active.state !== 'connected' || active.planSharing !== true)
            return {
              status: 'unavailable',
              source: 'official-api',
              auth: 'unauthenticated',
              reason: 'not-connected',
            };
          models = await client.listModels({ accessToken: refreshed, signal });
        }
        return {
          status: 'success',
          source: 'official-api',
          auth: 'authenticated',
          entries: models.map((model) => ({
            selection: { kind: 'model' as const, id: model.slug },
            displayName: model.displayName,
            availability: 'available' as const,
            compatibility: 'model-turn' as const,
            source: 'official-api' as const,
          })),
        };
      },
    },
    template: (entry) => {
      if (entry.selection.kind !== 'model')
        throw new Error('Account route requires an explicit model');
      // Materialization installs the returned slug and tuple ID; the template has no model claim.
      return chatGptPlanModelResource('account-model', entry.displayName);
    },
  };
}
