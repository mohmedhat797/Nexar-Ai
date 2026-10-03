/** Hard bounds from ADR-024 §5. */
export const MAX_SESSION_BYTES = 4 * 1024 * 1024;
export const MAX_TURNS = 1000;
export const MAX_TEXT_CHARS = 100_000;
export const MAX_OUTCOME_CHARS = 64 * 1024;
export const MAX_TITLE_CHARS = 200;
export const MAX_LIST = 200;
export const MAX_TASKS_PER_TURN = 32;
export const MAX_ARTIFACTS_PER_TURN = 64;
/** Lane executions recorded for one engineering turn (the plane's outcome bound). */
export const MAX_ENGINEERING_LANES = 16;
export const MAX_APPROVALS_PER_TURN = 32;
/** Longest stored error message / reason string. */
export const MAX_ERROR_MESSAGE_CHARS = 2000;
/**
 * Space `beginTurn` leaves free in the session file so the turn it starts can always be
 * completed or interrupted without exceeding {@link MAX_SESSION_BYTES}.
 */
export const SESSION_BYTES_HEADROOM = 256 * 1024;
