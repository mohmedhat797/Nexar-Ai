import { NexarError } from '@nexar/contracts';
import type { ResourceDescriptor, SecretResolver } from '@nexar/contracts';
import { PI_REASONING_LEVELS } from './pi-models.js';
import type { PiReasoningLevel } from './pi-models.js';

export interface PiRuntimeOptions {
  readonly baseUrl?: string;
  readonly maxTokens?: number;
  readonly reasoning?: PiReasoningLevel;
}

export function configError(message: string, details?: Record<string, unknown>): NexarError {
  return new NexarError('CONFIGURATION_ERROR', message, details ? { details } : {});
}

export function parseRuntimeOptions(resource: ResourceDescriptor): PiRuntimeOptions {
  const raw = resource.runtime.options ?? {};
  const { baseUrl, maxTokens, reasoning } = raw;
  const out: { baseUrl?: string; maxTokens?: number; reasoning?: PiReasoningLevel } = {};
  if (baseUrl !== undefined) {
    let protocol: string | undefined;
    try {
      protocol = typeof baseUrl === 'string' ? new URL(baseUrl).protocol : undefined;
    } catch {
      protocol = undefined;
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw configError('runtime.options.baseUrl must be an http(s) URL', {
        resource: resource.id,
      });
    }
    out.baseUrl = baseUrl as string;
  }
  if (maxTokens !== undefined) {
    if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens <= 0) {
      throw configError('runtime.options.maxTokens must be a positive integer', {
        resource: resource.id,
      });
    }
    out.maxTokens = maxTokens;
  }
  if (reasoning !== undefined) {
    if (!(PI_REASONING_LEVELS as readonly unknown[]).includes(reasoning)) {
      throw configError(
        `runtime.options.reasoning must be one of: ${PI_REASONING_LEVELS.join(', ')}`,
        { resource: resource.id },
      );
    }
    out.reasoning = reasoning as PiReasoningLevel;
  }
  return out;
}

/**
 * Reads the referenced env var or key store entry; empty or absent means "no credential". The
 * sources never fall back to each other. Never logs the value.
 */
export function readPiCredential(
  credential: Extract<ResourceDescriptor['auth'], { mode: 'api-key' }>['credential'],
  env: NodeJS.ProcessEnv,
  resolveSecret: SecretResolver | undefined,
): string | undefined {
  let value: string | undefined;
  if (credential.source === 'env') {
    value = env[credential.name];
  } else if (credential.source === 'keystore') {
    value = resolveSecret?.(credential.name);
  } else {
    throw configError('pi-ai resources need an env or keystore credential reference', {
      source: credential.source,
    });
  }
  return value === undefined || value === '' ? undefined : value;
}
