import { describe, expect, it } from 'vitest';
import { echoResource } from '@nexar/integration-echo';
import { DEFAULT_DISCOVERY_CONFIG, parseConfig } from './config.js';

const base = { version: 1, resources: [echoResource()] };
const parse = (discovery: unknown) => parseConfig({ ...base, discovery }, 'test');

describe('discovery config (ADR-020 §9)', () => {
  it('is disabled by default with documented defaults', () => {
    expect(parseConfig(base, 'test').discovery).toEqual(DEFAULT_DISCOVERY_CONFIG);
    expect(DEFAULT_DISCOVERY_CONFIG).toMatchObject({
      enabled: false,
      credentialSource: 'env',
      cli: { enabled: true },
      piCatalog: { enabled: false, providers: [] },
      localEndpoints: { enabled: true, endpoints: [] },
    });
  });

  it.each(['env', 'keystore'] as const)('preserves the explicit %s reference source', (source) => {
    expect(parse({ credentialSource: source }).discovery.credentialSource).toBe(source);
  });

  it('defaults a present discovery section to env without changing configured resources', () => {
    const configured = echoResource();
    const resource = {
      ...configured,
      auth: { mode: 'api-key', credential: { source: 'env', name: 'OWNER_API_KEY' } },
    };
    const parsed = parseConfig(
      { version: 1, resources: [resource], discovery: { credentialSource: 'keystore' } },
      'test',
    );
    expect(parse({}).discovery.credentialSource).toBe('env');
    expect(parsed.resources[0]?.auth).toEqual(resource.auth);
  });

  it('resolves owner settings over the defaults', () => {
    const d = parse({
      enabled: true,
      refreshIntervalMs: 60_000,
      excludeIds: ['codex'],
      sources: {
        cli: { enabled: false },
        piCatalog: { enabled: true, providers: ['anthropic', 'anthropic'], maxModels: 5 },
        localEndpoints: {
          endpoints: [{ id: 'ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' }],
        },
      },
    }).discovery;
    expect(d).toMatchObject({
      enabled: true,
      refreshIntervalMs: 60_000,
      timeoutMs: 3000,
      excludeIds: ['codex'],
      cli: { enabled: false },
      piCatalog: { enabled: true, providers: ['anthropic'], maxModels: 5 },
      localEndpoints: { enabled: true },
    });
    expect(d.localEndpoints.endpoints).toHaveLength(1);
  });

  it.each([
    ['an unknown key', { scan: true }],
    ['an unsupported credential source', { credentialSource: 'runtime-managed' }],
    ['a credential value object', { credentialSource: { source: 'keystore', value: 'secret' } }],
    ['a null credential source', { credentialSource: null }],
    ['a non-string credential source', { credentialSource: false }],
    ['a differently cased credential source', { credentialSource: 'Keystore' }],
    ['the catalog without a provider allowlist', { sources: { piCatalog: { enabled: true } } }],
    [
      'a non-http endpoint',
      {
        sources: {
          localEndpoints: { endpoints: [{ id: 'f', kind: 'ollama', baseUrl: 'file:///x' }] },
        },
      },
    ],
    [
      'an unknown endpoint kind',
      {
        sources: { localEndpoints: { endpoints: [{ id: 'x', kind: 'lan', baseUrl: 'http://a' }] } },
      },
    ],
    [
      'duplicate endpoint ids',
      {
        sources: {
          localEndpoints: {
            endpoints: [
              { id: 'x', kind: 'ollama', baseUrl: 'http://127.0.0.1:1' },
              { id: 'x', kind: 'ollama', baseUrl: 'http://127.0.0.1:2' },
            ],
          },
        },
      },
    ],
    ['a zero refresh interval', { refreshIntervalMs: 0 }],
  ])('rejects %s', (_name, discovery) => {
    expect(() => parse(discovery)).toThrow(/Invalid Nexar config/);
  });
});
