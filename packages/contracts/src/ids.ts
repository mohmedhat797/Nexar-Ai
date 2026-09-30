import { NexarError } from './errors.js';

/** Nominal typing helper so ids of different entities cannot be mixed up. */
export type Brand<T, B extends string> = T & { readonly __brand: B };

/** Identifies a unit of work submitted to Nexar. */
export type TaskId = Brand<string, 'TaskId'>;
/** Identifies an AI Resource (model, agent, tool runtime) in the registry. */
export type ResourceId = Brand<string, 'ResourceId'>;
/** Identifies a project: a named set of roots, working directories and document sets. */
export type ProjectId = Brand<string, 'ProjectId'>;
/** Identifies an execution adapter implementation. */
export type AdapterId = Brand<string, 'AdapterId'>;

const SLUG_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

function invalid(kind: string, rule: string): NexarError {
  return new NexarError('VALIDATION_ERROR', `Invalid ${kind}: ${rule}`, { details: { kind } });
}

function slug(kind: string, value: string): string {
  if (typeof value !== 'string' || !SLUG_PATTERN.test(value)) {
    throw invalid(kind, `must match ${String(SLUG_PATTERN)}`);
  }
  return value;
}

/** Validates and brands a task id (any non-empty string up to 128 chars). */
export function taskId(s: string): TaskId {
  if (typeof s !== 'string' || s.length === 0 || s.length > 128) {
    throw invalid('TaskId', 'must be a non-empty string of at most 128 characters');
  }
  return s as TaskId;
}

/** Validates and brands a resource id. */
export function resourceId(s: string): ResourceId {
  return slug('ResourceId', s) as ResourceId;
}

/** Validates and brands an adapter id. */
export function adapterId(s: string): AdapterId {
  return slug('AdapterId', s) as AdapterId;
}

/** Validates and brands a project id. */
export function projectId(s: string): ProjectId {
  return slug('ProjectId', s) as ProjectId;
}
