import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { NexarError } from '@nexar/contracts';
import type { Logger } from '@nexar/contracts';
import { parseConfig } from '@nexar/core';
import { writeFileAtomic } from './atomic-write.js';

export type RawConfig = Record<string, unknown>;

/**
 * The config written on first run: owner-facing defaults only. No resource is configured and none
 * is the default, so Auto chooses among discovered resources (the echo test double is not one).
 */
export function firstRunConfig(): RawConfig {
  return {
    version: 1,
    resources: [],
    routing: { policy: 'resource-intelligence' },
    telemetry: { jsonlPath: '.nexar/telemetry.jsonl' },
    discovery: { enabled: true },
    projects: [],
  };
}

/** The echo descriptor exactly as earlier versions of `firstRunConfig` wrote it (frozen on purpose). */
const LEGACY_ECHO_RESOURCE: unknown = {
  id: 'local-echo',
  displayName: 'Local Echo',
  kind: { type: 'model', provider: 'nexar', model: 'echo', access: 'local' },
  capabilities: [
    'text-generation',
    'reasoning',
    'knowledge-work',
    'coding',
    'repo-editing',
    'code-review',
    'tool-use',
    'shell-execution',
    'long-context',
    'web-research',
    'vision',
  ],
  runtime: { adapter: 'echo', locality: 'local' },
  auth: { mode: 'none' },
  cost: { model: 'free' },
  dataLocality: 'local',
};

/** A filename-safe UTC timestamp, e.g. `20261004T120000123Z`. */
function backupStamp(now: Date): string {
  return now.toISOString().replace(/[-:.]/g, '');
}
/**
 * `nexar.config.json` in the app's data directory. Every write is validated with `parseConfig`
 * first and replaces the file atomically; mutations are serialized.
 */
export class ConfigStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly path: string,
    private readonly logger?: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Creates the directory and the default config when there is none yet; migrates the old echo default. */
  async ensure(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT') throw error;
      await this.write(firstRunConfig());
      return;
    }
    await this.migrateEchoDefault(text);
  }

  /**
   * One-time: a config that is exactly what the old first run wrote (only the echo resource, echo as
   * the default) loses both, after a backup. Any other shape is the owner's and stays untouched.
   */
  private async migrateEchoDefault(text: string): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return; // Surfaces as CONFIGURATION_ERROR when the config is read.
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return;
    const config = raw as RawConfig;
    const routing = config.routing;
    if (
      !Array.isArray(config.resources) ||
      config.resources.length !== 1 ||
      !isDeepStrictEqual(config.resources[0], LEGACY_ECHO_RESOURCE) ||
      typeof routing !== 'object' ||
      routing === null ||
      (routing as Record<string, unknown>).defaultResourceId !== 'local-echo'
    ) {
      return;
    }
    try {
      // `wx`: never overwrite an existing backup; the original text is kept byte for byte.
      await writeFile(`${this.path}.bak-${backupStamp(this.now())}`, text, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      const rest = { ...(routing as Record<string, unknown>) };
      delete rest.defaultResourceId;
      await this.write({ ...config, resources: [], routing: rest });
    } catch {
      // Leave the config as it is: the owner can still use it, and the next start retries.
      this.logger?.warn('config migration skipped: echo default kept');
      return;
    }
    this.logger?.info('config migrated: echo default removed');
  }

  async readText(): Promise<string> {
    return readFile(this.path, 'utf8');
  }

  async read(): Promise<RawConfig> {
    let json: unknown;
    try {
      json = JSON.parse(await this.readText());
    } catch (cause) {
      throw new NexarError('CONFIGURATION_ERROR', 'The Nexar config is not valid JSON', { cause });
    }
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
      throw new NexarError('CONFIGURATION_ERROR', 'The Nexar config must be a JSON object');
    }
    return json as RawConfig;
  }

  /** Validates (throws `CONFIGURATION_ERROR`) and writes. */
  async write(raw: RawConfig): Promise<void> {
    parseConfig(raw, this.path, { baseDir: dirname(this.path) });
    await writeFileAtomic(this.path, JSON.stringify(raw, null, 2) + '\n');
  }

  /** Restores a previously read file text (used to roll back a change that fails to load). */
  async restoreText(text: string): Promise<void> {
    await writeFileAtomic(this.path, text);
  }

  /** Read-modify-write, one at a time. */
  update<T>(
    mutate: (raw: RawConfig) => Promise<T> | T,
    afterWrite?: (result: T) => Promise<void>,
  ): Promise<T> {
    const run = async (): Promise<T> => {
      const previousText = await this.readText();
      const raw = await this.read();
      const result = await mutate(raw);
      await this.write(raw);
      try {
        await afterWrite?.(result);
      } catch (error) {
        // Keep rollback in the same queue as all other config mutations.
        await this.restoreText(previousText);
        throw error;
      }
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
