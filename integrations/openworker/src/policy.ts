import { posix, win32 } from 'node:path';
import { recordPolicyDecision } from '@nexar/approvals';
import type { ApprovalContext, ApprovalRequest, ApprovalStore } from '@nexar/approvals';

/** A `permission_required` event reduced to the fields policy may look at. */
export interface PermissionRequest {
  readonly name: string;
  readonly category?: string;
  readonly target?: string;
}

export interface PermissionDecision {
  readonly decision: 'allow' | 'deny';
  readonly ruleId: string;
}

export const COWORK_RULES = {
  scratchWrite: 'cowork.scratch-write.allow',
  toolNotAllowed: 'cowork.tool-not-allowed.deny',
  targetMissing: 'cowork.target-missing.deny',
  targetOutsideScratch: 'cowork.target-outside-scratch.deny',
  readOnly: 'cowork.read-only.deny',
} as const;

const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'replace_in_file',
  'apply_patch',
  'apply_unified_diff',
]);

/** True for the tools that write files; the owner's ask-before-write setting asks for these only. */
export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.has(name);
}

/** True when `target` (absolute, or relative to the scratch root) lies strictly inside it. */
function insideScratch(scratchRoot: string, target: string, platform: NodeJS.Platform): boolean {
  if (target === '' || target.includes('\0') || scratchRoot === '') return false;
  const path = platform === 'win32' ? win32 : posix;
  if (!path.isAbsolute(scratchRoot)) return false;
  const root = path.resolve(scratchRoot);
  const resolved = path.resolve(root, target);
  // win32.relative compares case-insensitively and returns an absolute path across drives.
  const relative = path.relative(root, resolved);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Deterministic answer to a permission request (ADR-026 §3). Pure: it never inspects tool arguments.
 * Symlinks are not resolved here; the scratch directory is private and drafts are imported with
 * link checks.
 */
export function decidePermission(
  request: PermissionRequest,
  options: {
    readonly scratchRoot: string;
    readonly platform?: NodeJS.Platform;
    /** Read only Cowork (NXR-053): every request is denied, whatever the tool. */
    readonly readOnly?: boolean;
  },
): PermissionDecision {
  if (options.readOnly === true) return { decision: 'deny', ruleId: COWORK_RULES.readOnly };
  if (!WRITE_TOOLS.has(request.name)) {
    return { decision: 'deny', ruleId: COWORK_RULES.toolNotAllowed };
  }
  if (request.target === undefined || request.target === '') {
    return { decision: 'deny', ruleId: COWORK_RULES.targetMissing };
  }
  return insideScratch(options.scratchRoot, request.target, options.platform ?? process.platform)
    ? { decision: 'allow', ruleId: COWORK_RULES.scratchWrite }
    : { decision: 'deny', ruleId: COWORK_RULES.targetOutsideScratch };
}

export interface CoworkDecisionContext extends Pick<
  ApprovalContext,
  'taskId' | 'projectId' | 'clientId'
> {
  readonly sessionId: string;
  readonly turnId: string;
  readonly clock?: () => Date;
}

const SAFE_TOOL = /^[A-Za-z0-9_.-]{1,64}$/;

/** Records one decision as an approval policy decision; the record holds a fingerprint, no arguments. */
export function recordCoworkDecision(
  store: ApprovalStore,
  ctx: CoworkDecisionContext,
  request: PermissionRequest,
  decision: PermissionDecision,
): Promise<ApprovalRequest> {
  const allowed = decision.decision === 'allow';
  const tool = SAFE_TOOL.test(request.name) ? request.name : 'unknown';
  return recordPolicyDecision(
    store,
    {
      type: 'cowork.tool-call',
      target: tool,
      parameters: {
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        tool: request.name,
        target: request.target ?? null,
      },
    },
    {
      summary: `Cowork ${tool}: ${allowed ? 'allowed' : 'denied'} by policy`,
      risk: allowed ? 'low' : 'medium',
      ...(ctx.taskId === undefined ? {} : { taskId: ctx.taskId }),
      ...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
      ...(ctx.clientId === undefined ? {} : { clientId: ctx.clientId }),
      metadata: { ruleId: decision.ruleId, tool },
    },
    allowed ? 'allowed' : 'denied',
    ctx.clock === undefined ? {} : { clock: ctx.clock },
  );
}
