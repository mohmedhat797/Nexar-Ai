import type { ApiProviderId, ProviderRow, ResourceRow, SubscriptionRow } from '../shared/api.js';

/*
 * Provider cards (NXR-065): one card per provider, grouping the connection methods Desktop
 * supports for it. Built from the lists main already exposes; ids, enums and counts only.
 */

export const NOT_AVAILABLE_REASON =
  'Desktop does not support a connection method for this provider yet.';

type SubscriptionRuntimeId = SubscriptionRow['runtime'];

interface CardSpec {
  readonly id: string;
  readonly label: string;
  readonly apiProvider?: ApiProviderId;
  readonly subscription?: SubscriptionRuntimeId;
  readonly local?: true;
  /** Sign in with ChatGPT (the owner's ChatGPT plan, NXR-067). */
  readonly chatgptPlan?: true;
}

const CARD_SPECS: readonly CardSpec[] = [
  { id: 'anthropic', label: 'Anthropic', apiProvider: 'anthropic', subscription: 'claude-code' },
  {
    id: 'openai',
    label: 'OpenAI',
    apiProvider: 'openai',
    subscription: 'codex',
    chatgptPlan: true,
  },
  { id: 'google', label: 'Google / Gemini', apiProvider: 'google', subscription: 'antigravity' },
  { id: 'deepseek', label: 'DeepSeek', apiProvider: 'deepseek' },
  { id: 'mistral', label: 'Mistral', apiProvider: 'mistral' },
  { id: 'openrouter', label: 'OpenRouter', apiProvider: 'openrouter' },
  { id: 'groq', label: 'Groq', apiProvider: 'groq' },
  { id: 'xai', label: 'xAI', apiProvider: 'xai' },
  { id: 'local', label: 'Local / Custom', local: true },
];

export interface ProviderCard {
  readonly id: string;
  readonly label: string;
  readonly subscription?: SubscriptionRow | undefined;
  readonly apiKey?: ProviderRow | undefined;
  /** The Local / Custom card: its method is the local-endpoints view. */
  readonly local: boolean;
  /** The card shows the ChatGPT plan method (OpenAI). */
  readonly chatgptPlan: boolean;
  /** Registry resources whose connection names this provider. */
  readonly resourceCount: number;
  /** True when Desktop supports no method for this provider (the card shows a fixed reason). */
  readonly notAvailable: boolean;
}

export function groupProviderCards(input: {
  readonly keys: readonly ProviderRow[];
  readonly subscriptions: readonly SubscriptionRow[];
  readonly resources: readonly ResourceRow[];
}): readonly ProviderCard[] {
  return CARD_SPECS.map((spec) => {
    const apiKey =
      spec.apiProvider === undefined
        ? undefined
        : input.keys.find((row) => row.provider === spec.apiProvider);
    const subscription =
      spec.subscription === undefined
        ? undefined
        : input.subscriptions.find((row) => row.runtime === spec.subscription);
    const local = spec.local === true;
    const resourceCount = input.resources.filter((r) =>
      local
        ? r.connection?.method === 'local' || r.connection?.method === 'custom'
        : r.connection?.provider === spec.id,
    ).length;
    return {
      id: spec.id,
      label: spec.label,
      subscription,
      apiKey,
      local,
      chatgptPlan: spec.chatgptPlan === true,
      resourceCount,
      notAvailable:
        !local && !spec.chatgptPlan && apiKey === undefined && subscription === undefined,
    };
  });
}
