import { z } from 'zod';

export const SUBSCRIPTION_RUNTIME_IDS = ['claude-code', 'codex', 'antigravity'] as const;
export const SubscriptionArgsSchema = z.strictObject({ runtime: z.enum(SUBSCRIPTION_RUNTIME_IDS) });
export const SubscriptionRowSchema = z
  .strictObject({
    runtime: z.enum(SUBSCRIPTION_RUNTIME_IDS),
    method: z.literal('subscription'),
    status: z.enum(['connected', 'not-connected', 'unknown', 'unavailable']),
    authMode: z.enum(['vendor-account', 'api-key', 'none', 'unknown']),
    version: z
      .string()
      .regex(/^\d{1,5}\.\d{1,5}\.\d{1,5}$/)
      .optional(),
    loginSupported: z.boolean(),
    loginState: z.enum([
      'idle',
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'timed-out',
      'unavailable',
    ]),
    usableBy: z.enum(SUBSCRIPTION_RUNTIME_IDS),
  })
  .refine((row) => row.runtime === row.usableBy)
  .refine((row) => row.status !== 'connected' || row.authMode === 'vendor-account');
export type SubscriptionRow = z.output<typeof SubscriptionRowSchema>;
export const SubscriptionListSchema = z
  .array(SubscriptionRowSchema)
  .max(3)
  .refine((rows) => new Set(rows.map((row) => row.runtime)).size === rows.length);
