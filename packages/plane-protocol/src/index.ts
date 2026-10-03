/**
 * `@nexar/plane-protocol`: the versioned stdio protocol between Desktop and the WSL2 engineering
 * plane (ADR-025). Strict schemas, a newline-delimited frame decoder and encoder. No IO.
 */
export {
  MAX_DIFF_BYTES,
  MAX_DIFF_FILES,
  MAX_FRAME_BYTES,
  MAX_GOAL_CHARS,
  MAX_OUTCOME_LANES,
  MAX_REPORT_BYTES,
  MAX_TITLE_CHARS,
  PLANE_PROTOCOL,
} from './limits.js';
export * from './schemas.js';
export {
  FrameDecoder,
  createDesktopFrameDecoder,
  createPlaneFrameDecoder,
  encodeFrame,
  type DecodeFailure,
  type DecodeResult,
  type FrameDecoderOptions,
} from './codec.js';
