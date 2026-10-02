import type { TaskKind } from '@nexar/contracts';
import type { LaneDecision, OperatingLane, OperatingMode, TurnIntent } from '@nexar/sessions';

/*
 * `lanes@1`: a pure function of mode, intent and lane availability. It selects an orchestration
 * lane, never a resource (the NRC still routes every task with all of its hard filters), and a
 * confirmation selects a lane for one turn only: it grants no scope and never changes the mode.
 */

export const LANE_POLICY = 'lanes@1';

export interface LaneAvailability {
  readonly cowork: boolean;
  readonly code: boolean;
}

export interface LaneRefusal {
  readonly code: 'SANDBOX_UNAVAILABLE';
  readonly message: string;
}

export interface LaneOutcome {
  readonly action: 'run' | 'confirm' | 'refuse';
  readonly decision: LaneDecision;
  readonly refusal?: LaneRefusal;
}

export interface DecideLaneInput {
  readonly mode: OperatingMode;
  readonly intent: Pick<TurnIntent, 'kind'>;
  readonly available: LaneAvailability;
}

const CODE_LANE_REFUSAL: LaneRefusal = {
  code: 'SANDBOX_UNAVAILABLE',
  message:
    'Engineering changes need the Code lane (WSL2 engineering plane), which is not available yet.',
};

type DecisionBase = Omit<LaneDecision, 'effectiveLane' | 'fallbackReason'>;

/** The lane an intent prefers, independent of availability. */
export function affinityLane(kind: TaskKind, mode: OperatingMode): OperatingLane {
  switch (kind) {
    case 'coding':
    case 'review':
      return 'code';
    case 'documentation':
    case 'meeting-preparation':
      return 'cowork';
    default:
      return mode;
  }
}

function refuse(base: DecisionBase): LaneOutcome {
  return {
    action: 'refuse',
    decision: { ...base, effectiveLane: 'code', fallbackReason: 'code-lane-unavailable' },
    refusal: CODE_LANE_REFUSAL,
  };
}

/** `direct` is always available; an unavailable orchestrated lane falls back to it, recorded. */
function resolveEffective(
  requested: OperatingLane,
  available: LaneAvailability,
): Pick<LaneDecision, 'effectiveLane' | 'fallbackReason'> {
  if (requested === 'direct' || available[requested]) return { effectiveLane: requested };
  return { effectiveLane: 'direct', fallbackReason: 'orchestrator-unavailable' };
}

export function decideLane(input: DecideLaneInput): LaneOutcome {
  const { mode, intent, available } = input;
  const requestedLane = affinityLane(intent.kind, mode);
  const base: DecisionBase = {
    policy: LANE_POLICY,
    mode,
    requestedLane,
    ...(requestedLane === mode ? {} : { mismatch: { from: mode, to: requestedLane } }),
  };
  const engineeringWrite = intent.kind === 'coding';
  // Decided before any confirmation: never ask the owner to confirm something that will be refused.
  if (requestedLane === 'code' && !available.code && engineeringWrite) return refuse(base);
  return {
    action: requestedLane === mode ? 'run' : 'confirm',
    decision: { ...base, ...resolveEffective(requestedLane, available) },
  };
}

/**
 * Re-evaluates availability for an already-confirmed mismatch (the world may have changed while the
 * turn was pending). Engineering writes (`coding`) never fall back; read-only `review` may.
 */
export function confirmLane(
  decision: LaneDecision,
  available: LaneAvailability,
  intent: Pick<TurnIntent, 'kind'>,
): LaneOutcome {
  // Rebuilt without the previous effective lane and fallback reason: both are re-derived below.
  const base: DecisionBase = {
    policy: decision.policy,
    mode: decision.mode,
    requestedLane: decision.requestedLane,
    ...(decision.mismatch === undefined ? {} : { mismatch: decision.mismatch }),
    confirmed: true,
  };
  if (decision.requestedLane === 'code' && !available.code && intent.kind === 'coding') {
    return refuse(base);
  }
  return {
    action: 'run',
    decision: { ...base, ...resolveEffective(decision.requestedLane, available) },
  };
}
