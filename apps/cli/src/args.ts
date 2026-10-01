import { resolve } from 'node:path';
import type { ParseArgsOptionsConfig } from 'node:util';
import {
  resourceId,
  type ArtifactRef,
  type Logger,
  type NexarTask,
  type ProcessLauncher,
  type ResourceId,
} from '@nexar/contracts';
import type { Nexar } from '@nexar/core';
import type { EngineeringRunnerPort, EngineeringSeams } from '@nexar/host';
import type { SandboxAvailability, SelfTestOptions, SelfTestResult } from '@nexar/sandbox';
import { UsageError, type CliIo } from './io.js';

type OptionValue = string | boolean | (string | boolean)[] | undefined;

export type { EngineeringRunnerPort };

/** Result of a `<command> --version` probe. */
export type VersionProbe =
  { readonly found: true; readonly output: string } | { readonly found: false };

/**
 * Test seams: pieces of the outside world a command may be handed instead of the real ones.
 * `runCli` passes `{}` in production.
 */
export interface CliSeams {
  readonly engineering?: EngineeringSeams;
  readonly sandbox?: {
    readonly availability?: () => Promise<SandboxAvailability>;
    readonly runSelfTest?: (
      launcher: ProcessLauncher,
      options: SelfTestOptions,
    ) => Promise<SelfTestResult[]>;
  };
  readonly doctor?: {
    readonly availability?: () => Promise<SandboxAvailability>;
    /** Reads a host file; `undefined` when it does not exist. */
    readonly readText?: (path: string) => Promise<string | undefined>;
    readonly versionOf?: (command: string, args?: readonly string[]) => Promise<VersionProbe>;
  };
}

/** What a command receives: global options already resolved, plus its own raw option values. */
export interface CommandContext {
  readonly io: CliIo;
  readonly logger: Logger;
  readonly configPath: string | undefined;
  readonly json: boolean;
  readonly values: Readonly<Record<string, OptionValue>>;
  readonly positionals: readonly string[];
  readonly seams: CliSeams;
}

export interface Command {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  readonly options: ParseArgsOptionsConfig;
  run(ctx: CommandContext): Promise<number>;
}

export const GLOBAL_OPTIONS = {
  config: { type: 'string' },
  'log-level': { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
} as const satisfies ParseArgsOptionsConfig;

/** Options shared by `route` and `run`. */
export const TASK_OPTIONS = {
  kind: { type: 'string' },
  capability: { type: 'string', multiple: true },
  prefer: { type: 'string', multiple: true },
  exclude: { type: 'string', multiple: true },
  'local-only': { type: 'boolean' },
  'max-cost': { type: 'string' },
  'require-known-quota': { type: 'boolean' },
  project: { type: 'string' },
} as const satisfies ParseArgsOptionsConfig;

export function stringOption(ctx: CommandContext, name: string): string | undefined {
  const value = ctx.values[name];
  return typeof value === 'string' ? value : undefined;
}

export function listOption(ctx: CommandContext, name: string): string[] {
  const value = ctx.values[name];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function flagOption(ctx: CommandContext, name: string): boolean {
  return ctx.values[name] === true;
}

function toResourceId(raw: string): ResourceId {
  try {
    return resourceId(raw);
  } catch {
    throw new UsageError(`invalid resource id "${raw}"`);
  }
}

/** `--max-cost <usd>`: a non-negative, finite USD amount (ADR-020 §5). */
function maxCostOption(ctx: CommandContext): number | undefined {
  const raw = stringOption(ctx, 'max-cost');
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value) || value < 0) {
    throw new UsageError('--max-cost must be a non-negative number of US dollars');
  }
  return value;
}

/** The prompt: positional words joined, or all of stdin when the only positional is `-`. */
export async function readPrompt(ctx: CommandContext): Promise<string> {
  let prompt: string;
  if (ctx.positionals.length === 1 && ctx.positionals[0] === '-') {
    if (ctx.io.stdin === undefined) throw new UsageError('stdin is not available for prompt "-"');
    prompt = (await ctx.io.stdin()).replace(/\r?\n$/, '');
  } else {
    prompt = ctx.positionals.join(' ');
  }
  if (prompt.trim() === '') throw new UsageError('a prompt is required');
  return prompt;
}

/** Builds a task from the shared task options. `cwd` becomes the task's working directory. */
export async function buildTask(
  nexar: Nexar,
  ctx: CommandContext,
  extra: { readonly cwd?: string; readonly attachments?: readonly ArtifactRef[] } = {},
): Promise<NexarTask> {
  const kind = stringOption(ctx, 'kind');
  if (kind === undefined || kind === '') throw new UsageError('--kind <kind> is required');
  const prompt = await readPrompt(ctx);
  const capabilities = listOption(ctx, 'capability');
  const preferred = listOption(ctx, 'prefer').map(toResourceId);
  const excluded = listOption(ctx, 'exclude').map(toResourceId);
  const project = stringOption(ctx, 'project');
  const maxCostUsd = maxCostOption(ctx);
  return nexar.createTask({
    kind,
    prompt,
    ...(project === undefined ? {} : { projectId: project }),
    ...(extra.attachments === undefined || extra.attachments.length === 0
      ? {}
      : { attachments: extra.attachments }),
    requirements: {
      capabilities,
      ...(preferred.length === 0 ? {} : { preferredResourceIds: preferred }),
      ...(excluded.length === 0 ? {} : { excludedResourceIds: excluded }),
      ...(flagOption(ctx, 'local-only') ? { privacy: 'local-only' as const } : {}),
      ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
      ...(flagOption(ctx, 'require-known-quota') ? { requireKnownQuota: true } : {}),
    },
    ...(extra.cwd === undefined ? {} : { workingDirectory: resolve(ctx.io.cwd, extra.cwd) }),
  });
}
