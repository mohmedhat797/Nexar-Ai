import type {
  ApprovalDto,
  CodeDiffDto,
  PlaneStateDto,
  ProjectPlaneStateDto,
  TurnDto,
  TurnLaneDto,
} from '../shared/api.js';

/*
 * Pure helpers of the Code surface. Everything here turns bridge DTOs (ids, scalars and the fixed
 * texts main already built) into the plain strings the renderer shows; nothing is ever HTML.
 */

/** Characters of a goal shown in the engineering panel (the full text is the user's own bubble). */
export const MAX_GOAL_CHARS = 240;
/** Diff lines rendered; main bounds the diff itself (256 KiB), this bounds the DOM. */
export const MAX_DIFF_LINES = 4000;
const SHORT_SHA = 12;

/** Shown beside every Approve commit button: what an approval does and does not do. */
export const COMMIT_NOTE =
  'Approving lets Nexar create a local commit on a new branch. Nothing is pushed.';

/** Fallback texts for a turn that ran with Nexar direct execution instead of the Code lane. */
const FALLBACK_TEXT: Readonly<Record<string, string>> = {
  'openworker-unavailable': 'OpenWorker unavailable. Using Nexar direct execution.',
  'openworker-control-unavailable':
    'No control-compatible resource can run Cowork. Using Nexar direct execution.',
  'code-report-unavailable':
    'Read-only repository review ran with Nexar direct execution: the engineering plane has no report-only plan.',
  'code-engineering-only':
    'Only engineering requests run on the engineering plane; this one ran with Nexar direct execution.',
};

/** The visible fallback line for a lane decision; null when there is nothing to say. */
export function fallbackText(lane: TurnLaneDto): string | null {
  const known = lane.fallbackReason === undefined ? undefined : FALLBACK_TEXT[lane.fallbackReason];
  if (known !== undefined) return known;
  if (lane.fallbackReason !== 'orchestrator-unavailable') return null;
  if (lane.requestedLane === 'cowork') {
    return 'OpenWorker unavailable. Using Nexar direct execution.';
  }
  if (lane.requestedLane === 'code') {
    return 'Code lane (DeepSeek Harness) unavailable. Using Nexar direct execution.';
  }
  return null;
}

const EXECUTOR_REASON_TEXT: Readonly<Record<string, string>> = {
  'engine-unavailable': 'the engine is not available',
  'control-unavailable': 'no resource can run the engine’s control loop',
  'engine-not-selected': 'the engine was not selected for this lane',
  'control-resource-failed': 'the control resource failed',
};

/** A fixed human text for an executor reason code; an unknown code is shown as itself. */
export function executorReasonText(code: string): string {
  return EXECUTOR_REASON_TEXT[code] ?? code;
}

type LaneFacts = NonNullable<NonNullable<TurnDto['outcome']>['engineering']>['lanes'];

/** `Executor: DeepSeek Harness (control: <resource>)` or `Executor: native (<reason>)`. */
export function laneExecutorText(lane: NonNullable<LaneFacts>[number]): string | null {
  if (lane.executor === 'engine') {
    const name = lane.engine === 'dsh' ? 'DeepSeek Harness' : 'OpenWorker';
    return `Executor: ${name}${lane.controlResourceId === undefined ? '' : ` (control: ${lane.controlResourceId})`}`;
  }
  if (lane.executor === 'native') {
    return `Executor: native${lane.executorReason === undefined ? '' : ` (${executorReasonText(lane.executorReason)})`}`;
  }
  return null;
}

/** `Control: Nexar gateway on <resource>` or `Control: direct key (temporary)`, plus restarts. */
export function coworkControlText(control: TurnDto['tasks'][number]['control']): string | null {
  if (control === undefined) return null;
  const path =
    control.path === 'gateway'
      ? `Control: Nexar gateway${control.resourceId === undefined ? '' : ` on ${control.resourceId}`}`
      : 'Control: direct key (temporary)';
  return control.restarts !== undefined && control.restarts > 0
    ? `${path} · restarts: ${String(control.restarts)}`
    : path;
}

/** A turn Nexar refused before running anything (an engineering write without the Code lane). */
export function isRefusedTurn(turn: TurnDto): boolean {
  return turn.state === 'failed' && turn.outcome?.error?.code === 'SANDBOX_UNAVAILABLE';
}

/** Whether a turn gets an engineering panel: it ran (or runs) on the Code lane. */
export function isCodeTurn(turn: TurnDto): boolean {
  if (turn.outcome?.engineering !== undefined) return true;
  if (turn.state === 'pending-confirmation' || turn.state === 'declined') return false;
  return turn.lane?.effectiveLane === 'code' && !isRefusedTurn(turn);
}

/** Whether a turn ran on the Cowork lane (orchestrated by OpenWorker). */
export function isCoworkTurn(turn: TurnDto): boolean {
  if (turn.state === 'pending-confirmation' || turn.state === 'declined') return false;
  return turn.lane?.effectiveLane === 'cowork';
}

export function shortSha(commit: string): string {
  return commit.slice(0, SHORT_SHA);
}

export function clipGoal(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_GOAL_CHARS ? `${flat.slice(0, MAX_GOAL_CHARS)}…` : flat;
}

/** The current phase of a running turn: its last progress line. */
export function currentPhase(turn: TurnDto, lines: readonly string[]): string | undefined {
  return turn.state === 'running' ? lines[lines.length - 1] : undefined;
}

export type ApprovalState =
  'pending' | 'approved' | 'denied' | 'not-approved' | 'not-requested' | 'not-required';

export const APPROVAL_LABEL: Readonly<Record<ApprovalState, string>> = {
  pending: 'Waiting for your decision',
  approved: 'Approved',
  denied: 'Denied',
  'not-approved': 'Not approved',
  'not-requested': 'Not requested yet',
  'not-required': 'Not required',
};

/**
 * The approval state of a Code turn. A pending plane approval comes from `approvals:list`; a
 * decision made in this window is remembered until the turn record catches up; afterwards the
 * outcome tells: committed after an approval means approved, an unaccepted run means it was not.
 */
export function approvalState(
  turn: TurnDto,
  pending: ApprovalDto | undefined,
  decided: 'approved' | 'denied' | undefined,
): ApprovalState {
  const engineering = turn.outcome?.engineering;
  if (engineering?.approvalId !== undefined) {
    if (engineering.status === 'committed') return 'approved';
    if (engineering.status === 'not-accepted')
      return decided === 'denied' ? 'denied' : 'not-approved';
    return 'not-approved';
  }
  if (decided !== undefined) return decided;
  if (pending !== undefined && turn.state === 'running') return 'pending';
  return turn.state === 'running' ? 'not-requested' : 'not-required';
}

/** The plane approval waiting for a turn, if any. */
export function pendingFor(
  approvals: readonly ApprovalDto[],
  sessionId: string,
  turnId: string,
): ApprovalDto | undefined {
  return approvals.find(
    (a) =>
      a.source === 'plane' &&
      a.status === 'pending' &&
      a.sessionId === sessionId &&
      a.turnId === turnId,
  );
}

export const ENGINEERING_STATUS_LABEL = {
  committed: 'Committed',
  reported: 'Reported',
  'not-accepted': 'Not accepted',
  failed: 'Failed',
  cancelled: 'Cancelled',
} as const;

/** Lines of a diff with the class that colors them; text only. */
export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx';

export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith('@@')) return 'hunk';
  if (
    line.startsWith('+++') ||
    line.startsWith('---') ||
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('similarity ') ||
    line.startsWith('rename ')
  ) {
    return 'meta';
  }
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
}

export interface DiffView {
  readonly lines: readonly DiffLine[];
  /** True when more lines existed than are shown. */
  readonly clipped: boolean;
}

export function diffLines(diff: Pick<CodeDiffDto, 'text'>): DiffView {
  const all = diff.text.split('\n');
  // A diff ends with a newline: the empty tail is not a line.
  if (all[all.length - 1] === '') all.pop();
  const shown = all.slice(0, MAX_DIFF_LINES);
  return {
    lines: shown.map((text) => ({ kind: classifyDiffLine(text), text })),
    clipped: all.length > shown.length,
  };
}

/** States in which the banner shows the "set the plane project" form. */
export function needsPlaneProject(state: ProjectPlaneStateDto | PlaneStateDto): boolean {
  return state === 'project-unmapped' || state === 'project-unknown-to-plane';
}
