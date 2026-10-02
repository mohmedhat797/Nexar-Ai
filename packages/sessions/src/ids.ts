import { randomBytes } from 'node:crypto';
import { NexarError } from '@nexar/contracts';

export const SESSION_ID_PATTERN = /^ses_[0-9a-f]{32}$/;
export const TURN_ID_PATTERN = /^turn_[0-9a-f]{32}$/;
export const SUBMISSION_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
/** Same shape as `@nexar/approvals` ids; sessions only reference them. */
export const APPROVAL_ID_PATTERN = /^apr_[0-9a-f]{32}$/;
/** Same shape as `projectId()` in `@nexar/contracts`. */
export const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

function assertPattern(kind: string, pattern: RegExp, value: unknown): void {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new NexarError('VALIDATION_ERROR', `Invalid ${kind}`, { details: { kind } });
  }
}

export function assertSessionId(value: unknown): asserts value is string {
  assertPattern('SessionId', SESSION_ID_PATTERN, value);
}

export function assertTurnId(value: unknown): asserts value is string {
  assertPattern('TurnId', TURN_ID_PATTERN, value);
}

export function assertSubmissionKey(value: unknown): asserts value is string {
  assertPattern('SubmissionKey', SUBMISSION_KEY_PATTERN, value);
}

export function assertProjectId(value: unknown): asserts value is string {
  assertPattern('ProjectId', PROJECT_ID_PATTERN, value);
}

/** 32 lowercase hex characters from a CSPRNG. */
export function randomHex(): string {
  return randomBytes(16).toString('hex');
}

export function newSessionId(): string {
  return `ses_${randomHex()}`;
}

export function newTurnId(): string {
  return `turn_${randomHex()}`;
}
