import { z } from 'zod';

/** Fixed, owner-readable lines for the connection states; the DTO can carry nothing else. */
export const CHATGPT_PLAN_MESSAGES = {
  'signed-out': 'Not connected.',
  'signing-in': 'Waiting for you to finish signing in with ChatGPT in your browser.',
  connected: 'Connected. Sign out in Nexar to forget this sign-in on this computer.',
  disconnected:
    'Disconnected on this computer. You can also revoke Nexar in your ChatGPT settings.',
  cancelled: 'Sign-in cancelled.',
  expired: 'The ChatGPT sign-in expired. Sign in again.',
  denied: 'ChatGPT did not authorize the sign-in.',
  timeout: 'The sign-in was not finished in time.',
  failed: 'The sign-in could not be completed.',
  'key-store-unavailable': 'Secure credential storage is unavailable on this computer.',
} as const;
export type ChatGptPlanMessage = (typeof CHATGPT_PLAN_MESSAGES)[keyof typeof CHATGPT_PLAN_MESSAGES];

const REASONS = [
  'disconnected',
  'cancelled',
  'expired',
  'denied',
  'timeout',
  'failed',
  'key-store-unavailable',
] as const;
export type ChatGptPlanReason = (typeof REASONS)[number];

const MESSAGES = Object.values(CHATGPT_PLAN_MESSAGES) as [string, ...string[]];

/** The status DTO: no token, code, URL, account identifier or email, ever. */
export const ChatGptPlanStatusSchema = z.strictObject({
  state: z.enum(['signed-out', 'signing-in', 'connected', 'error']),
  /** Whether the grant lets Nexar spend the ChatGPT plan (`chatgpt.tokens.use.direct`). */
  planSharing: z.boolean().optional(),
  reason: z.enum(REASONS).optional(),
  message: z.enum(MESSAGES),
});
export type ChatGptPlanStatus = z.output<typeof ChatGptPlanStatusSchema>;
