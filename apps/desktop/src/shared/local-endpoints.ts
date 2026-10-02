import { z } from 'zod';

export const EndpointIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/);
/** Public addresses only: credentials never belong in endpoint settings or IPC. */
export const EndpointUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    if (!/^https?:\/\//.test(value) || value.includes('\\')) return false;
    // Address settings reject control characters rather than silently normalizing them.
    // eslint-disable-next-line no-control-regex
    if (/\s|[?#\x00-\x1f\x7f]/.test(value)) return false;
    try {
      const url = new URL(value);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        url.username === '' &&
        url.password === '' &&
        url.search === '' &&
        url.hash === ''
      );
    } catch {
      return false;
    }
  });
export const EndpointInputSchema = z.strictObject({
  id: EndpointIdSchema,
  kind: z.enum(['ollama', 'openai-compatible']),
  baseUrl: EndpointUrlSchema,
});
export const EndpointSaveSchema = EndpointInputSchema.extend({ id: EndpointIdSchema.optional() });
export const EndpointRemoveSchema = z.strictObject({ id: EndpointIdSchema });
export const EndpointRowSchema = EndpointInputSchema.extend({
  modelCount: z.number().int().min(0).max(200),
  enabled: z.boolean(),
});
export const EndpointListSchema = z
  .array(EndpointRowSchema)
  .max(32)
  .refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length);
export type LocalEndpointInput = z.output<typeof EndpointSaveSchema>;
export type LocalEndpointRow = z.output<typeof EndpointRowSchema>;
