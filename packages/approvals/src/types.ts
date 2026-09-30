export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [k: string]: JsonValue };

/** The exact thing that would execute once approved. Never persisted in full. */
export interface OutwardAction {
  /** Dotted kind, e.g. `email.send`, `calendar.update`, `file.delete`. */
  readonly type: string;
  /** Safe human summary of the target (at most 200 characters). */
  readonly target: string;
  readonly parameters: { readonly [k: string]: JsonValue };
}

export type ApprovalStatus =
  'pending' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'consumed';

/** Stored approval record. Deliberately carries no `action.parameters`, only their fingerprint. */
export interface ApprovalRequest {
  /** `apr_` + 128-bit random hex. */
  readonly id: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** The gate instance (process) that is waiting on this request. */
  readonly instanceId: string;
  readonly taskId?: string;
  readonly projectId?: string;
  readonly clientId?: string;
  readonly actionType: string;
  readonly summary: string;
  readonly risk: RiskLevel;
  /** sha256 hex of `canonicalJson(action)`. */
  readonly fingerprint: string;
  readonly metadata?: { readonly [k: string]: string | number | boolean };
  readonly status: ApprovalStatus;
  readonly decidedAt?: string;
  readonly decidedBy?: string;
  readonly reason?: string;
}
