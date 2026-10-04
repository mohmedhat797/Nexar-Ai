import { NexarError, isNexarError, type NexarErrorCode } from '@nexar/contracts';

/** Why a call to the account service failed. Fixed ids only: nothing from a response ever leaks. */
export type AccountFailureReason =
  | 'grant-rejected'
  | 'rejected'
  | 'server'
  | 'network'
  | 'timeout'
  | 'malformed'
  | 'oversize'
  | 'id-token'
  | 'cancelled';

const FAILURES: Readonly<
  Record<AccountFailureReason, { readonly code: NexarErrorCode; readonly message: string }>
> = {
  'grant-rejected': { code: 'AUTH_REQUIRED', message: 'The ChatGPT sign-in is no longer valid' },
  rejected: { code: 'PROVIDER_ERROR', message: 'The ChatGPT sign-in service rejected the request' },
  server: { code: 'PROVIDER_ERROR', message: 'The ChatGPT sign-in service is unavailable' },
  network: { code: 'PROVIDER_ERROR', message: 'The ChatGPT sign-in service could not be reached' },
  timeout: { code: 'EXECUTION_TIMEOUT', message: 'The ChatGPT sign-in service timed out' },
  malformed: {
    code: 'PROVIDER_ERROR',
    message: 'The ChatGPT sign-in service returned an unexpected response',
  },
  oversize: {
    code: 'PROVIDER_ERROR',
    message: 'The ChatGPT sign-in service returned an unexpected response',
  },
  'id-token': { code: 'AUTH_REQUIRED', message: 'The ChatGPT identity could not be verified' },
  cancelled: { code: 'EXECUTION_CANCELLED', message: 'The ChatGPT sign-in was cancelled' },
};

export function accountError(reason: AccountFailureReason): NexarError {
  const { code, message } = FAILURES[reason];
  return new NexarError(code, message, { details: { reason } });
}

/** The fixed reason of an error made by this package, if it is one. */
export function accountFailureReason(error: unknown): AccountFailureReason | undefined {
  if (!isNexarError(error)) return undefined;
  const reason = error.details?.['reason'];
  return typeof reason === 'string' && Object.hasOwn(FAILURES, reason)
    ? (reason as AccountFailureReason)
    : undefined;
}
