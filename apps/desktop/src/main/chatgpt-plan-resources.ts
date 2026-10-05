import { chatGptPlanModelResource } from '@nexar/host';
import type { ResourceDescriptor } from '@nexar/contracts';
import type { ChatGptPlanService } from './chatgpt-plan.js';
import type { SettingsStore } from './settings-store.js';

/**
 * The model resources of a connected ChatGPT plan: one per model the owner lists (default
 * `gpt-5.2`), published only while the connection is `connected` with plan sharing granted. Reads
 * status and settings only; no token, no network, no model call (probes never pay, ADR-020).
 */
export async function chatGptPlanResources(
  plan: Pick<ChatGptPlanService, 'status'> | undefined,
  settings: Pick<SettingsStore, 'getChatGptPlan'>,
): Promise<readonly ResourceDescriptor[]> {
  if (plan === undefined) return [];
  const status = await plan.status();
  if (status.state !== 'connected' || status.planSharing !== true) return [];
  const config = await settings.getChatGptPlan();
  // A damaged section publishes nothing rather than guessing the owner's list.
  return config.valid ? config.value.models.map(chatGptPlanModelResource) : [];
}
