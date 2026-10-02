/** Metadata endpoint authentication only; never a statement about credits or generation access. */
export type ProviderKeyCheckStatus = 'valid' | 'invalid' | 'unchecked' | 'unavailable';

export interface ProviderKeyCheck {
  readonly status: ProviderKeyCheckStatus;
  /** Count in this bounded first page, when the endpoint returns a model list. */
  readonly modelCount?: number;
}
