import type { ArtifactRef } from './artifacts.js';
import type { Capability } from './capabilities.js';
import type { ResourceId, TaskId } from './ids.js';

/** Task kinds Nexar ships with first-class knowledge of. */
export const KNOWN_TASK_KINDS = [
  'documentation',
  'analysis',
  'coding',
  'review',
  'research',
  'meeting-preparation',
  'automation',
  'general',
] as const;

/** A task kind Nexar ships with first-class knowledge of. */
export type KnownTaskKind = (typeof KNOWN_TASK_KINDS)[number];

/** Open task-kind vocabulary so new workloads need no code change. */
export type TaskKind = KnownTaskKind | (string & {});

/** What a task needs from a resource, expressed independently of any provider. */
export interface TaskRequirements {
  readonly capabilities: readonly Capability[];
  readonly privacy?: 'standard' | 'local-only';
  readonly minContextTokens?: number;
  readonly maxCostUsd?: number;
  readonly preferredResourceIds?: readonly ResourceId[];
  readonly excludedResourceIds?: readonly ResourceId[];
}

/** Where a task came from, for attribution and tracing across clients. */
export interface TaskOrigin {
  readonly source: 'cli' | 'openworker' | 'control-plane' | 'mobile' | 'test' | (string & {});
  readonly project?: string;
  readonly correlationId?: string;
  readonly requestedBy?: string;
}

/** The payload a resource acts on. */
export interface TaskInput {
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly attachments?: readonly ArtifactRef[];
  readonly workingDirectory?: string;
}

/** The provider-neutral unit of work that Nexar routes and executes. */
export interface NexarTask {
  readonly id: TaskId;
  readonly kind: TaskKind;
  readonly title?: string;
  readonly input: TaskInput;
  readonly requirements: TaskRequirements;
  readonly origin: TaskOrigin;
  /** ISO-8601 timestamp. */
  readonly createdAt: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
