import { z } from 'zod';
import { PROVIDER_INVENTORY_FAILURE_REASONS, PROVIDER_MODEL_SOURCES } from '@nexar/contracts';

export const INVENTORY_SOURCE_IDS = [
  'chatgpt-plan',
  'claude-code',
  'codex',
  'antigravity',
] as const;
export type InventorySourceId = (typeof INVENTORY_SOURCE_IDS)[number];
const publicText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) =>
      [...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
    );
const identityPart = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/);
export const ModelSelectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('model'), id: publicText(200) }),
  z.strictObject({ kind: z.literal('provider-default') }),
]);
export const ProviderInventorySchema = z.strictObject({
  identity: z.strictObject({
    provider: identityPart,
    connectionId: identityPart,
    runtimeId: identityPart,
    routeId: identityPart,
    machine: z.enum(['desktop', 'plane']),
  }),
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  status: z.enum(['fresh', 'stale', 'unavailable', 'unsupported']),
  source: z.enum(PROVIDER_MODEL_SOURCES),
  auth: z.enum(['authenticated', 'unauthenticated', 'not-required', 'unknown']),
  observedAt: z.iso.datetime().optional(),
  attemptedAt: z.iso.datetime().optional(),
  reason: z.enum(PROVIDER_INVENTORY_FAILURE_REASONS).optional(),
  runtimeVersion: publicText(128).optional(),
  current: ModelSelectionSchema.optional(),
  entries: z
    .array(
      z.strictObject({
        selection: ModelSelectionSchema,
        displayName: publicText(160),
        availability: z.enum(['available', 'degraded', 'unavailable', 'unknown']),
        compatibility: z.enum(['native-agent', 'model-turn']),
        source: z.enum(PROVIDER_MODEL_SOURCES).optional(),
        capabilities: z.array(identityPart).max(32).optional(),
        limits: z
          .strictObject({
            contextWindowTokens: z.number().int().positive().max(100_000_000).optional(),
            maxOutputTokens: z.number().int().positive().max(100_000_000).optional(),
          })
          .optional(),
        reasoningModes: z.array(publicText(64)).max(16).optional(),
      }),
    )
    .max(256),
});
export const InventoryArgsSchema = z.strictObject({ sourceId: z.enum(INVENTORY_SOURCE_IDS) });
export const InventoryRowSchema = z.strictObject({
  sourceId: z.enum(INVENTORY_SOURCE_IDS),
  inventory: ProviderInventorySchema,
  refreshing: z.boolean(),
  resources: z
    .array(
      z.strictObject({
        id: identityPart,
        displayName: publicText(160),
        selection: ModelSelectionSchema,
      }),
    )
    .max(256),
});
export type InventoryRow = z.output<typeof InventoryRowSchema>;
export const InventoryListSchema = z.array(InventoryRowSchema).max(4);
export const InventoryCacheSchema = z.strictObject({
  version: z.literal(1),
  inventories: z
    .array(
      z.strictObject({
        sourceId: z.enum(INVENTORY_SOURCE_IDS),
        inventory: ProviderInventorySchema,
      }),
    )
    .max(4),
});
