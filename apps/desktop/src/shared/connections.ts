import { z } from 'zod';

export const ConnectionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);

export const ConnectionAddArgsSchema = z.strictObject({
  provider: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  label: z.string().min(1).max(128),
  apiKey: z
    .string()
    .min(16)
    .max(4096)
    .regex(/^[A-Za-z0-9_.:-]{16,4096}$/),
});
export type ConnectionAddArgs = z.infer<typeof ConnectionAddArgsSchema>;

export const ConnectionIdArgsSchema = z.strictObject({
  connectionId: ConnectionIdSchema,
});
export type ConnectionIdArgs = z.infer<typeof ConnectionIdArgsSchema>;

export const ConnectionRotateArgsSchema = z.strictObject({
  connectionId: ConnectionIdSchema,
  apiKey: z
    .string()
    .min(16)
    .max(4096)
    .regex(/^[A-Za-z0-9_.:-]{16,4096}$/),
});
export type ConnectionRotateArgs = z.infer<typeof ConnectionRotateArgsSchema>;

export const ConnectionDtoSchema = z.strictObject({
  id: ConnectionIdSchema,
  provider: z.string().min(1).max(64),
  method: z.enum(['subscription', 'api', 'local', 'custom'] as const),
  authClass: z.enum([
    'vendor-native',
    'official-api',
    'official-account',
    'experimental-client-compat',
    'none',
  ] as const),
  support: z.enum(['official', 'experimental'] as const),
  machine: z.enum(['desktop', 'plane'] as const),
  label: z.string().min(1).max(128),
  enabled: z.boolean(),
  builtIn: z.boolean(),
  credentialScopeKind: z.enum(['keystore', 'account', 'native-home', 'none'] as const),
  credentialGeneration: z.number().int().nonnegative(),
  identityAssurance: z.enum([
    'VERIFIED_SAME_ACCOUNT',
    'OWNER_ASSERTED_SAME_ACCOUNT',
    'VERIFIED_DIFFERENT_ACCOUNT',
    'IDENTITY_UNKNOWN',
  ] as const),
  lifecycleState: z.enum(['ACTIVE', 'DISABLED', 'TOMBSTONED'] as const),
  hasCredential: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ConnectionDto = z.infer<typeof ConnectionDtoSchema>;

export const ConnectionListSchema = z.array(ConnectionDtoSchema);
