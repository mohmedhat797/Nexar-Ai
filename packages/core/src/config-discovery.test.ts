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
      cli: { enabled: true },
      piCatalog: { enabled: false, providers: [] },
      localEndpoints: { enabled: true, endpoints: [] },
    });
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
