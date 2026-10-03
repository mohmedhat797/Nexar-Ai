/** Protocol id of the Desktop to WSL2 engineering-plane bridge (ADR-025). */
export const PLANE_PROTOCOL = 'nexar-plane/1';

/** A frame is one newline-delimited JSON line of at most this many bytes (without the newline). */
export const MAX_FRAME_BYTES = 1024 * 1024;
/** The `diff` frame carries at most this many bytes of patch text. */
export const MAX_DIFF_BYTES = 256 * 1024;
/** The `diff` frame lists at most this many changed files. */
export const MAX_DIFF_FILES = 500;
/** A `completed` outcome carries at most this many bytes of report text (status `reported`). */
export const MAX_REPORT_BYTES = 64 * 1024;
/** A `completed` outcome lists at most this many lane executions. */
export const MAX_OUTCOME_LANES = 16;
/** Same bound as the engineering runner's goal limit. */
export const MAX_GOAL_CHARS = 20_000;
