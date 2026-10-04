/**
 * `@nexar/sessions`: the durable Operating Session domain (ADR-024) and its file store.
 *
 * Headless and orchestrator-agnostic: no routing, intent, adapter, network or approval-execution
 * code. Sessions only reference approval and artifact ids; the Operating Layer drives them.
 */
export {
  APPROVAL_ID_PATTERN,
  PROJECT_ID_PATTERN,
  SESSION_ID_PATTERN,
  SUBMISSION_KEY_PATTERN,
  TURN_ID_PATTERN,
  assertProjectId,
  assertSessionId,
  assertSubmissionKey,
  assertTurnId,
  newSessionId,
  newTurnId,
  randomHex,
} from './ids.js';
export {
  MAX_APPROVALS_PER_TURN,
  MAX_ARTIFACTS_PER_TURN,
  MAX_ENGINEERING_LANES,
  MAX_ERROR_MESSAGE_CHARS,
  MAX_LIST,
  MAX_OUTCOME_CHARS,
  MAX_SESSION_BYTES,
  MAX_TASKS_PER_TURN,
  MAX_TEXT_CHARS,
  MAX_TITLE_CHARS,
  MAX_TURNS,
  SESSION_BYTES_HEADROOM,
} from './limits.js';
export { parseSession, serializeSession } from './record.js';
export { FileSessionStore } from './store.js';
export type { BeginTurnRequest, CreateSessionRequest, FileSessionStoreOptions } from './store.js';
export {
  beginTurn,
  completeTurn,
  createSession,
  interruptRunning,
  linkApprovals,
  linkArtifacts,
  linkTask,
  rename,
  resolveConfirmation,
  setContext,
  setMode,
  updateTask,
} from './transitions.js';
export type {
  BeginTurnInput,
  BeginTurnResult,
  CompleteTurnInput,
  ConfirmationDecision,
  CreateSessionInput,
  InterruptResult,
  TaskUpdate,
  TurnMutation,
} from './transitions.js';
export { TERMINAL_TURN_STATES } from './types.js';
export type {
  ContextManifest,
  LaneDecision,
  OperatingLane,
  OperatingMode,
  OperatingSession,
  SessionSummary,
  Turn,
  TurnControl,
  TurnEngineering,
  TurnEngineeringLane,
  TurnEngineeringStatus,
  TurnIntent,
  TurnOutcome,
  TurnState,
  TurnTaskLink,
  TurnTaskState,
  UnavailableSession,
} from './types.js';
