import { NexarError, isNexarError, type ProviderKeyCheck } from '@nexar/contracts';
import { providerCredentialNames } from '@nexar/host';
import { openWorkerProviderFor } from '@nexar/integration-openworker';
import {
  API_PROVIDER_IDS,
  OpenWorkerAccessArgsSchema,
  ProviderArgsSchema,
  ProviderListSchema,
  ProviderRowSchema,
  PROVIDER_ERROR_MESSAGE,
  type ApiProviderId,
  type ProviderRow,
} from '../shared/providers.js';
import { CHANNELS } from '../shared/channels.js';
import { NoArgs, defineChannel, type CallContext, type ChannelDefinition } from './channel.js';
import type { ConfigStore, RawConfig } from './config-store.js';
import type { DesktopKeyStore } from './desktop-key-store.js';
import type { EngineHost } from './engine-host.js';
import type { SettingsStore } from './settings-store.js';

export interface ClipboardPort {
  readText(): Promise<string> | string;
  clear(): Promise<void> | void;
}

/** All secret handling stays here in trusted main; the bridge only accepts provider ids. */
export class ProviderService {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly checks = new Map<ApiProviderId, ProviderRow['keyCheckStatus']>();

  constructor(
    private readonly deps: {
      readonly keys: DesktopKeyStore;
      readonly clipboard: ClipboardPort;
      readonly config: ConfigStore;
      readonly engine: EngineHost;
      /** Owner opt-in for OpenWorker's use of a key (ADR-026); absent means nothing is allowed. */
      readonly settings?: Pick<SettingsStore, 'getCowork' | 'setOpenWorkerAccess'>;
      readonly checkKey?: (provider: ApiProviderId) => Promise<ProviderKeyCheck>;
    },
  ) {}

  list(): Promise<readonly ProviderRow[]> {
    return this.safe(async () => {
      const allowed = await this.allowed();
      return ProviderListSchema.parse(API_PROVIDER_IDS.map((p) => this.row(p, allowed)));
    });
  }

  saveFromClipboard(provider: ApiProviderId): Promise<ProviderRow> {
    return this.serialized(async () => {
      const copied = await this.deps.clipboard.readText();
      const key = copied.trim();
      if (!/^[A-Za-z0-9_.:-]{16,4096}$/.test(key)) {
        throw new NexarError(
          'VALIDATION_ERROR',
          'The clipboard does not contain a supported API key',
        );
      }
      await this.deps.keys.save(this.name(provider), key);
      this.checks.delete(provider);
      try {
        await this.configure(provider);
      } finally {
        // Do not erase a newer clipboard value copied while encryption/reload was in flight.
        if ((await this.deps.clipboard.readText()) === copied) await this.deps.clipboard.clear();
      }
      return ProviderRowSchema.parse(this.row(provider, await this.allowed()));
    });
  }

  remove(provider: ApiProviderId): Promise<ProviderRow> {
    return this.serialized(async () => {
      await this.deps.keys.remove(this.name(provider));
      this.checks.delete(provider);
      // Keep explicit keystore references: a removed key must never fall back to the environment.
      await this.configure(provider, false);
      return ProviderRowSchema.parse(this.row(provider, await this.allowed()));
    });
  }

  check(provider: ApiProviderId): Promise<ProviderRow> {
    return this.serialized(async () => {
      const allowed = await this.allowed();
      const row = this.row(provider, allowed);
      let status: ProviderRow['keyCheckStatus'] = 'unchecked';
      if (row.status === 'saved' && this.deps.checkKey !== undefined) {
        try {
          status = ProviderRowSchema.shape.keyCheckStatus.parse(
            (await this.deps.checkKey(provider)).status,
          );
        } catch {
          status = 'unavailable';
        }
      }
      this.checks.set(provider, status);
      return this.row(provider, allowed);
    });
  }

  /**
   * Lets (or stops) OpenWorker use this provider's saved key. Only providers OpenWorker supports
   * can be allowed; the key itself never moves.
   */
  setOpenWorkerAccess(provider: ApiProviderId, allowed: boolean): Promise<ProviderRow> {
    return this.serialized(async () => {
      this.name(provider);
      const { settings } = this.deps;
      if (settings === undefined || (allowed && openWorkerProviderFor(provider) === undefined)) {
        throw new NexarError('VALIDATION_ERROR', PROVIDER_ERROR_MESSAGE);
      }
      await settings.setOpenWorkerAccess(provider, allowed);
      return ProviderRowSchema.parse(this.row(provider, await this.allowed()));
    });
  }

  private async allowed(): Promise<ReadonlySet<string>> {
    const config = await this.deps.settings?.getCowork();
    return new Set(config?.valid === true ? config.value.allowedProviders : []);
  }

  private name(provider: ApiProviderId): string {
    if (!API_PROVIDER_IDS.includes(provider))
      throw new NexarError('VALIDATION_ERROR', PROVIDER_ERROR_MESSAGE);
    const name = providerCredentialNames[provider];
    if (name === undefined) throw new NexarError('VALIDATION_ERROR', PROVIDER_ERROR_MESSAGE);
    return name;
  }

  private row(provider: ApiProviderId, allowed: ReadonlySet<string>): ProviderRow {
    const name = this.name(provider);
    let status: ProviderRow['status'] = 'unavailable';
    let lastFour: string | undefined;
    try {
      const metadata = this.deps.keys.metadata(name);
      lastFour = metadata.lastFour;
      if (this.deps.keys.availability()) status = metadata.present ? 'saved' : 'missing';
    } catch {
      /* Damaged state stays unavailable; never return its contents or error text. */
    }
    const models = this.deps.engine
      .composition()
      .runtime.registry.list()
      .filter(
        (r) =>
          r.runtime.adapter === 'pi' &&
          r.auth.mode === 'api-key' &&
          r.auth.credential.source !== 'runtime-managed' &&
          r.auth.credential.name === name,
      );
    return ProviderRowSchema.parse({
      provider,
      method: 'api-key',
      status,
      keyCheckStatus: status === 'saved' ? (this.checks.get(provider) ?? 'unchecked') : 'unchecked',
      ...(lastFour === undefined ? {} : { lastFour }),
      usableBy: provider === 'deepseek' ? ['pi', 'deepseek-harness'] : ['pi'],
      modelCount: models.length,
      openWorkerSupported: openWorkerProviderFor(provider) !== undefined,
      openWorkerAllowed: allowed.has(provider) && openWorkerProviderFor(provider) !== undefined,
    });
  }

  private async configure(provider: ApiProviderId, enableCatalog = true): Promise<void> {
    const name = this.name(provider);
    await this.deps.config.update(
      (raw) => {
        const previous = object(raw['discovery']);
        const sources = object(previous['sources']);
        const pi = object(sources['piCatalog']);
        const chosen: unknown[] = Array.isArray(pi['providers']) ? pi['providers'] : [];
        raw['discovery'] = {
          ...previous,
          credentialSource: 'keystore',
          ...(enableCatalog
            ? {
                enabled: true,
                sources: {
                  ...sources,
                  piCatalog: {
                    ...pi,
                    enabled: true,
                    providers: [...new Set([...chosen, provider])],
                  },
                },
              }
            : {}),
        };
        if (Array.isArray(raw['resources'])) {
          for (const entry of raw['resources']) {
            const resource = object(entry);
            const auth = object(resource['auth']);
            const credential = object(auth['credential']);
            const runtime = object(resource['runtime']);
            if (
              (runtime['adapter'] === 'pi' || runtime['adapter'] === 'deepseek-harness') &&
              credential['name'] === name &&
              auth['mode'] === 'api-key'
            ) {
              resource['auth'] = { ...auth, credential: { source: 'keystore', name } };
            }
          }
        }
      },
      () => this.deps.engine.reload(),
    );
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => this.safe(task));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async safe<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } catch (error) {
      const code = isNexarError(error) ? error.code : 'INTERNAL_ERROR';
      throw new NexarError(code, PROVIDER_ERROR_MESSAGE);
    }
  }
}

function object(value: unknown): RawConfig {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as RawConfig)
    : {};
}

function requireProviders(service: ProviderService | undefined): ProviderService {
  if (service === undefined) throw new NexarError('AUTH_REQUIRED', PROVIDER_ERROR_MESSAGE);
  return service;
}

/** Key or OpenWorker-access changes can change Cowork availability: re-probe in the background. */
function coworkChanged(ctx: CallContext): void {
  void ctx.deps.cowork?.refresh().catch(() => undefined);
}

export const providerChannels: Readonly<Record<string, ChannelDefinition>> = {
  [CHANNELS.providersCheckKey]: defineChannel(ProviderArgsSchema, async (args, ctx) =>
    ProviderRowSchema.parse(await requireProviders(ctx.deps.providers).check(args.provider)),
  ),
  [CHANNELS.providersList]: defineChannel(NoArgs, async (_args, ctx) =>
    ProviderListSchema.parse(await requireProviders(ctx.deps.providers).list()),
  ),
  [CHANNELS.providersSaveKeyFromClipboard]: defineChannel(ProviderArgsSchema, async (args, ctx) => {
    const row = ProviderRowSchema.parse(
      await requireProviders(ctx.deps.providers).saveFromClipboard(args.provider),
    );
    coworkChanged(ctx);
    return row;
  }),
  [CHANNELS.providersSetOpenWorkerAccess]: defineChannel(
    OpenWorkerAccessArgsSchema,
    async (args, ctx) => {
      const row = ProviderRowSchema.parse(
        await requireProviders(ctx.deps.providers).setOpenWorkerAccess(args.provider, args.allowed),
      );
      coworkChanged(ctx);
      return row;
    },
  ),
  [CHANNELS.providersRemoveKey]: defineChannel(ProviderArgsSchema, async (args, ctx) => {
    const row = ProviderRowSchema.parse(
      await requireProviders(ctx.deps.providers).remove(args.provider),
    );
    coworkChanged(ctx);
    return row;
  }),
};
