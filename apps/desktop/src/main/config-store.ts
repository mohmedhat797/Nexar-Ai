import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { NexarError } from '@nexar/contracts';
import { defaultConfig, parseConfig } from '@nexar/core';
import { writeFileAtomic } from './atomic-write.js';

export type RawConfig = Record<string, unknown>;

/** The config written on first run: the built-in echo resource plus the owner-facing defaults. */
export function firstRunConfig(): RawConfig {
  return {
    version: 1,
    // The same descriptor the built-in default uses, as plain JSON.
    resources: JSON.parse(JSON.stringify(defaultConfig().resources)) as unknown,
    routing: { policy: 'resource-intelligence', defaultResourceId: 'local-echo' },
    telemetry: { jsonlPath: '.nexar/telemetry.jsonl' },
    discovery: { enabled: true },
    projects: [],
  };
}

/**
 * `nexar.config.json` in the app's data directory. Every write is validated with `parseConfig`
 * first and replaces the file atomically; mutations are serialized.
 */
export class ConfigStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly path: string) {}

  /** Creates the directory and the default config when there is none yet. */
  async ensure(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      await readFile(this.path);
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT') throw error;
      await this.write(firstRunConfig());
    }
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
  update<T>(mutate: (raw: RawConfig) => Promise<T> | T): Promise<T> {
    const run = async (): Promise<T> => {
      const raw = await this.read();
      const result = await mutate(raw);
      await this.write(raw);
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
