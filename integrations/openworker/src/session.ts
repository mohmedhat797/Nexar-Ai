import { isAbsolute, resolve } from 'node:path';
import type { OpenWorkerClient } from './client.js';
import type { PermissionRequest } from './policy.js';

export const MAX_TEXT_BYTES = 64 * 1024;
export const MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;
const MAX_PROMPT_CHARS = 200_000;
const MAX_DECISIONS = 256;
const IDENTIFIER = /^[A-Za-z0-9_.-]{1,64}$/;

/** The upstream's accepted `approval` decision strings live here only. */
const APPROVAL_DECISION = { allow: 'allow', deny: 'deny' } as const;

/** Event types forwarded as progress; everything else is ignored. */
const PROGRESS_TYPES: ReadonlySet<string> = new Set([
  'turn_start',
  'tool_started',
  'tool_finished',
  'permission_required',
  'assistant_message',
]);

export const COWORK_ERROR_CODES = {
  invalidRequest: 'OPENWORKER_INVALID_REQUEST',
  rootFailed: 'OPENWORKER_ROOT_FAILED',
  turnError: 'OPENWORKER_TURN_ERROR',
  inputRejected: 'OPENWORKER_INPUT_REJECTED',
  inputRequired: 'OPENWORKER_INPUT_REQUIRED',
  malformedFrame: 'OPENWORKER_MALFORMED_FRAME',
  connectionClosed: 'OPENWORKER_CONNECTION_CLOSED',
  timeout: 'OPENWORKER_TURN_TIMEOUT',
  tooManyPermissions: 'OPENWORKER_TOO_MANY_PERMISSIONS',
} as const;

export interface CoworkTurnRequest {
  readonly sessionId: string;
  readonly prompt: string;
  readonly model?: string;
  readonly scratchDir: string;
  readonly projectRoot: string;
  readonly persona?: string;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
  /** Constant identifiers only: an event type, optionally `:<tool name>`. */
  readonly onProgress: (identifier: string) => void;
  /**
   * Answers a permission request; may wait (an owner approval). A rejection or throw denies. The
   * turn's timeout and abort still end the wait.
   */
  readonly decide: (request: PermissionRequest) => 'allow' | 'deny' | Promise<'allow' | 'deny'>;
  /**
   * The upstream session mode: interactive (default) or discuss (no tool use, read-only talk).
   * Nexar's policy still denies every write in discuss.
   */
  readonly mode?: 'discuss' | 'interactive';
}

export interface CoworkTurnResult {
  readonly text: string;
  readonly outcome: 'completed' | 'cancelled' | 'failed';
  readonly errorCode?: string;
}

function boundedText(value: string): string {
  return Buffer.byteLength(value) <= MAX_TEXT_BYTES
    ? value
    : Buffer.from(value).subarray(0, MAX_TEXT_BYTES).toString('utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function frameText(frame: Record<string, unknown>): string | undefined {
  const text = frame['text'];
  return typeof text === 'string' ? text : undefined;
}

/** v0.3.1 sends single-file write paths in arguments; never forward content or infer patch targets. */
function permissionTarget(frame: Record<string, unknown>, scratchDir: string): string | undefined {
  const target = frame['target'];
  if (
    (frame['name'] !== 'write_file' && frame['name'] !== 'replace_in_file') ||
    frame['arguments'] === undefined
  ) {
    return typeof target === 'string' ? target : undefined;
  }
  const args = frame['arguments'];
  const path = isRecord(args) && typeof args['path'] === 'string' ? args['path'] : undefined;
  if (path === undefined || path === '') return undefined;
  // Legacy fixtures may supply both fields. Conflicting destinations must not gain permission.
  if (target !== undefined) {
    if (typeof target !== 'string') return undefined;
    const left = resolve(scratchDir, target);
    const right = resolve(scratchDir, path);
    const same =
      process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
    if (!same) return undefined;
  }
  return path;
}

function validRequest(request: CoworkTurnRequest): boolean {
  return (
    IDENTIFIER.test(request.sessionId) &&
    request.prompt !== '' &&
    request.prompt.length <= MAX_PROMPT_CHARS &&
    isAbsolute(request.scratchDir) &&
    isAbsolute(request.projectRoot) &&
    (request.persona === undefined || IDENTIFIER.test(request.persona)) &&
    (request.model === undefined || /^[A-Za-z0-9_.:/-]{1,128}$/.test(request.model))
  );
}

/**
 * Runs one Cowork turn on a supervised OpenWorker session (ADR-026 §1). Never rejects: failures are
 * reported as `failed` with a fixed code. Progress carries identifiers only, never arguments or text.
 */
export async function runCoworkTurn(
  client: Pick<OpenWorkerClient, 'attachRoot' | 'openSession'>,
  request: CoworkTurnRequest,
): Promise<CoworkTurnResult> {
  if (!validRequest(request)) {
    return { text: '', outcome: 'failed', errorCode: COWORK_ERROR_CODES.invalidRequest };
  }
  if (request.signal.aborted) return { text: '', outcome: 'cancelled' };
  try {
    await client.attachRoot(request.sessionId, request.projectRoot, false);
  } catch {
    return { text: '', outcome: 'failed', errorCode: COWORK_ERROR_CODES.rootFailed };
  }
  if (request.signal.aborted) return { text: '', outcome: 'cancelled' };

  return new Promise<CoworkTurnResult>((resolve) => {
    const connection = client.openSession(request.sessionId, {
      ...(request.persona === undefined ? {} : { persona: request.persona }),
      workspace: request.scratchDir,
    });
    let settled = false;
    let started = false;
    let decisions = 0;
    let streamed = '';
    let final: string | undefined;

    const send = (frame: Record<string, unknown>): void => {
      try {
        connection.send(JSON.stringify(frame));
      } catch {
        /* A dead socket surfaces through onClose. */
      }
    };
    const progress = (identifier: string): void => {
      try {
        request.onProgress(identifier);
      } catch {
        /* A progress consumer cannot fail the turn. */
      }
    };
    const finish = (result: Omit<CoworkTurnResult, 'text'>, interrupt: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal.removeEventListener('abort', onAbort);
      if (interrupt) send({ type: 'interrupt' });
      connection.close();
      resolve({ text: boundedText(final ?? streamed), ...result });
    };
    const fail = (errorCode: string, interrupt = false): void =>
      finish({ outcome: 'failed', errorCode }, interrupt);
    const onAbort = (): void => finish({ outcome: 'cancelled' }, true);
    const timer = setTimeout(
      () => fail(COWORK_ERROR_CODES.timeout, true),
      request.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
    );
    request.signal.addEventListener('abort', onAbort, { once: true });

    const handle = (frame: Record<string, unknown>, type: string): void => {
      switch (type) {
        case 'ready':
          if (started) return;
          started = true;
          send({ type: 'set_mode', mode: request.mode ?? 'interactive' });
          send({
            type: 'user_message',
            text: request.prompt,
            ...(request.model === undefined ? {} : { model: request.model }),
          });
          return;
        case 'permission_required': {
          const name = frame['name'];
          if (typeof name !== 'string' || name === '')
            return fail(COWORK_ERROR_CODES.malformedFrame, true);
          if (++decisions > MAX_DECISIONS) return fail(COWORK_ERROR_CODES.tooManyPermissions, true);
          const category = frame['category'];
          const target = permissionTarget(frame, request.scratchDir);
          const permission = {
            name,
            ...(typeof category === 'string' ? { category } : {}),
            ...(typeof target === 'string' ? { target } : {}),
          };
          const label = IDENTIFIER.test(name) ? name : 'unknown';
          // Fail closed: a throw or a rejection is a denial; an answer after the turn ended is dropped.
          const answer = new Promise<'allow' | 'deny'>((done) => {
            try {
              Promise.resolve(request.decide(permission)).then(
                (value) => done(value === 'allow' ? 'allow' : 'deny'),
                () => done('deny'),
              );
            } catch {
              done('deny');
            }
          });
          void answer.then((decision) => {
            if (settled) return;
            send({ type: 'approval', decision: APPROVAL_DECISION[decision] });
            progress(`permission_required:${label}`);
          });
          return;
        }
        case 'assistant_delta': {
          const text = frameText(frame);
          if (text !== undefined && Buffer.byteLength(streamed) < MAX_TEXT_BYTES) streamed += text;
          return;
        }
        case 'assistant_message': {
          const text = frameText(frame);
          if (text !== undefined) final = boundedText(text);
          progress(type);
          return;
        }
        // Interactive requests never reach an owner from a supervised turn (ADR-026): a folder
        // or missing-tool request is declined, anything that needs an answer ends the turn
        // promptly instead of stalling until the timeout.
        case 'directory_requested':
          send({ type: 'directory_response', granted: false, path: '', writable: false });
          progress(type);
          return;
        case 'tool_requested':
          send({ type: 'tool_response', approved: false });
          progress(type);
          return;
        case 'question_requested':
        case 'plan_proposed':
        case 'connector_requested':
          return fail(COWORK_ERROR_CODES.inputRequired, true);
        case 'error':
          return fail(COWORK_ERROR_CODES.turnError);
        case 'input_rejected':
          return fail(COWORK_ERROR_CODES.inputRejected);
        case 'turn_done':
          return finish({ outcome: 'completed' }, false);
        default:
          if (!PROGRESS_TYPES.has(type)) return;
          if (type === 'tool_started' || type === 'tool_finished') {
            const name = frame['name'];
            progress(
              `${type}:${typeof name === 'string' && IDENTIFIER.test(name) ? name : 'unknown'}`,
            );
          } else progress(type);
      }
    };

    connection.onMessage((data) => {
      if (settled) return;
      if (typeof data !== 'string' || Buffer.byteLength(data) > MAX_FRAME_BYTES) {
        return fail(COWORK_ERROR_CODES.malformedFrame, true);
      }
      let frame: unknown;
      try {
        frame = JSON.parse(data);
      } catch {
        return fail(COWORK_ERROR_CODES.malformedFrame, true);
      }
      if (!isRecord(frame) || typeof frame['type'] !== 'string') {
        return fail(COWORK_ERROR_CODES.malformedFrame, true);
      }
      // Upstream events are `{ type, data: { ... } }` (coworker/server/manager.py, app.py): every
      // payload field is read from `data`, never from the envelope.
      const payload = frame['data'];
      handle(isRecord(payload) ? payload : {}, frame['type']);
    });
    connection.onClose(() => fail(COWORK_ERROR_CODES.connectionClosed));
    if (request.signal.aborted) onAbort();
  });
}
