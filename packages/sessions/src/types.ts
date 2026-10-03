import type { ArtifactRef, TaskKind } from '@nexar/contracts';

export type OperatingMode = 'cowork' | 'code';
export type OperatingLane = 'cowork' | 'code' | 'direct';

export type TurnState =
  | 'pending-confirmation'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'declined';

/** Terminal turn states never change again. */
export const TERMINAL_TURN_STATES: readonly TurnState[] = [
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
  'declined',
];

/** What the turn needs; records the kind and matched rule ids, never text. */
export interface TurnIntent {
  readonly kind: TaskKind;
  readonly source: 'explicit' | 'rules';
  readonly ruleIds: readonly string[];
  readonly policy: string;
}

export interface LaneDecision {
  readonly policy: string;
  readonly mode: OperatingMode;
  readonly requestedLane: OperatingLane;
  readonly effectiveLane: OperatingLane;
  readonly mismatch?: { readonly from: OperatingLane; readonly to: OperatingLane };
  readonly confirmed?: boolean;
  readonly fallbackReason?: string;
}

export type TurnTaskState = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export interface TurnTaskLink {
  readonly taskId: string;
  readonly state: TurnTaskState;
  readonly resourceId?: string;
  readonly policyId?: string;
  readonly fallback?: boolean;
}

/** Why a turn received the context it did (ADR-024 §10); never holds content. */
export interface ContextManifest {
  readonly policy: string;
  readonly turnIds: readonly string[];
  readonly omittedTurns: number;
  readonly truncatedTurnIds: readonly string[];
  readonly chars: number;
  readonly artifactIds: readonly string[];
  readonly hash: string;
}

export type TurnEngineeringStatus = 'committed' | 'not-accepted' | 'failed' | 'cancelled';

/**
 * What the engineering plane reported for a Code-lane turn (ADR-025 section 7): ids and scalars
 * only. Never a diff, a path, gate output or a prompt.
 */
export interface TurnEngineering {
  readonly planeTaskId: string;
  readonly status: TurnEngineeringStatus;
  readonly branch?: string;
  readonly commit?: string;
  readonly files?: number;
  readonly gatesPassed?: number;
  readonly reviewVerdict?: string;
  readonly approvalId?: string;
}

export interface TurnOutcome {
  readonly text?: string;
  readonly textTruncated?: boolean;
  readonly error?: { readonly code: string; readonly message: string };
  readonly engineering?: TurnEngineering;
}

export interface Turn {
  readonly id: string;
  readonly index: number;
  readonly submissionKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly text: string;
  readonly state: TurnState;
  readonly intent?: TurnIntent;
  readonly lane?: LaneDecision;
  readonly tasks: readonly TurnTaskLink[];
  readonly artifacts: readonly ArtifactRef[];
  readonly approvalIds: readonly string[];
  readonly context?: ContextManifest;
  readonly outcome?: TurnOutcome;
}

export interface OperatingSession {
  readonly schemaVersion: 1;
  readonly id: string;
  /** Immutable for the whole life of the session (ADR-024 §3). */
  readonly projectId: string;
  readonly mode: OperatingMode;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly activeTurnId: string | null;
  readonly modeChangedAt?: string;
  readonly turns: readonly Turn[];
}

export interface SessionSummary {
  readonly id: string;
  readonly projectId: string;
  readonly mode: OperatingMode;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly turnCount: number;
  readonly activeTurnId: string | null;
  readonly lastTurnState?: TurnState;
}

/** Listing entry for a file that is corrupt, oversized or otherwise refused. */
export interface UnavailableSession {
  readonly id: string;
  readonly unavailable: true;
}
