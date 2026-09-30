import { NexarError } from '@nexar/contracts';
import { ANY_SCOPE, type ClientIdentity } from './credentials.js';

/** What a caller is asking to do. */
export interface AuthorizationRequest {
  readonly tool: string;
  readonly taskKind?: string;
  readonly projectId?: string;
  readonly workflowId?: string;
  readonly maxCostUsd?: number;
}

export type ScopeDimension = 'tool' | 'task-kind' | 'project' | 'workflow' | 'cost';

function allows(list: readonly string[], value: string): boolean {
  return list.includes(ANY_SCOPE) || list.includes(value);
}

function reject(scope: ScopeDimension): never {
  throw new NexarError('POLICY_REJECTED', 'Not permitted for this client', { details: { scope } });
}

/** Throws `POLICY_REJECTED` (naming only the failing dimension) unless the client may do `request`. */
export function authorize(identity: ClientIdentity, request: AuthorizationRequest): void {
  const { scopes } = identity;
  if (!allows(scopes.tools, request.tool)) reject('tool');
  if (request.taskKind !== undefined && !allows(scopes.taskKinds, request.taskKind)) {
    reject('task-kind');
  }
  if (request.projectId !== undefined && !allows(scopes.projects, request.projectId)) {
    reject('project');
  }
  if (request.workflowId !== undefined && !allows(scopes.workflows, request.workflowId)) {
    reject('workflow');
  }
  if (
    request.maxCostUsd !== undefined &&
    (!Number.isFinite(request.maxCostUsd) || request.maxCostUsd < 0)
  ) {
    reject('cost');
  }
}

/**
 * The cost cap a request must run under: `min(requested, client cap)`. Callers put this into task
 * requirements. Returns undefined only when neither side sets a cap.
 */
export function effectiveMaxCost(identity: ClientIdentity, requested?: number): number | undefined {
  const cap = identity.scopes.maxCostUsd;
  if (cap === undefined) return requested;
  return requested === undefined ? cap : Math.min(requested, cap);
}
