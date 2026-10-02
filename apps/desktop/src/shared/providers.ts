import { z } from 'zod';

export const API_PROVIDER_IDS = [
  'anthropic',
  'openai',
  'google',
  'deepseek',
  'openrouter',
  'groq',
  'mistral',
  'xai',
] as const;
export type ApiProviderId = (typeof API_PROVIDER_IDS)[number];
export const ProviderArgsSchema = z.strictObject({ provider: z.enum(API_PROVIDER_IDS) });
export const ProviderRowSchema = z.strictObject({
  provider: z.enum(API_PROVIDER_IDS),
  method: z.literal('api-key'),
  status: z.enum(['missing', 'saved', 'unavailable']),
  lastFour: z
    .string()
    .regex(/^[A-Za-z0-9_.:-]{4}$/)
    .optional(),
  usableBy: z.array(z.enum(['pi', 'deepseek-harness'])).max(2),
  modelCount: z.number().int().nonnegative().max(100_000),
});
export type ProviderRow = z.output<typeof ProviderRowSchema>;
export const ProviderListSchema = z.array(ProviderRowSchema).max(API_PROVIDER_IDS.length);

/** Fixed messages: even a malformed dependency must not return credential-bearing errors. */
export const PROVIDER_ERROR_MESSAGE = 'Provider setup could not be completed';
