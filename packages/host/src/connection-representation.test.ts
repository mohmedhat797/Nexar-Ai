import {
  adapterId,
  connectionOf,
  isControlCompatible,
  resourceId,
  type ResourceDescriptor,
} from '@nexar/contracts';
import { antigravityResource } from '@nexar/integration-antigravity';
import { claudeCodeResource } from '@nexar/integration-claude-code';
import { codexResource } from '@nexar/integration-codex';
import { deepseekHarnessResource } from '@nexar/integration-deepseek-harness';
import { piCatalogDiscoverySource, piModelResource } from '@nexar/integration-pi';
import { describe, expect, it } from 'vitest';

const ctx = { now: new Date(), signal: new AbortController().signal };

async function catalog(provider: string): Promise<ResourceDescriptor> {
  const found = await piCatalogDiscoverySource({
    providers: [provider],
    listModels: () =>
      Promise.resolve([
        {
          id: 'm',
          contextWindow: 1000,
          maxTokens: 100,
          inputPerMillionTokens: 1,
          outputPerMillionTokens: 1,
        },
      ]),
  }).discover(ctx);
  return found[0]!;
}

describe('provider connection representation', () => {
  it('yields the expected connection and control compatibility per resource', async () => {
    const local = (id: string, kind: 'ollama' | 'openai-compatible', toolCalling: boolean) =>
      localEndpoint(id, kind, toolCalling);
    const rows = [
      ['claude-code', claudeCodeResource()],
      ['pi anthropic', await catalog('anthropic')],
      ['codex', codexResource()],
      ['pi openai', await catalog('openai')],
      ['antigravity', antigravityResource()],
      ['pi google', await catalog('google')],
      ['pi deepseek', await catalog('deepseek')],
      ['dsh', deepseekHarnessResource()],
      ['ollama tools', await local('ollama', 'ollama', true)],
      ['custom no tools', await local('lab', 'openai-compatible', false)],
    ] as const;
    const table = rows.map(([name, d]) => {
      const c = connectionOf(d);
      return `${name}: ${c?.id}/${c?.method}/${c?.authClass}/${c?.support} control=${String(
        isControlCompatible(d, 'dsh'),
      )}`;
    });
    expect(table).toEqual([
      'claude-code: anthropic.subscription/subscription/vendor-native/official control=false',
      'pi anthropic: anthropic.api/api/official-api/official control=true',
      'codex: openai.subscription/subscription/vendor-native/official control=false',
      'pi openai: openai.api/api/official-api/official control=true',
      'antigravity: google.subscription/subscription/vendor-native/experimental control=false',
      'pi google: google.api/api/official-api/official control=true',
      'pi deepseek: deepseek.api/api/official-api/official control=true',
      'dsh: deepseek.api/api/official-api/official control=false',
      'ollama tools: local.ollama/local/none/official control=true',
      'custom no tools: local.lab/custom/none/official control=false',
    ]);
  });

  it('infers the same connection for a configured pi resource as discovery sets', () => {
    const configured = piModelResource({ id: 'x', provider: 'anthropic', model: 'm' });
    expect(connectionOf(configured)?.id).toBe('anthropic.api');
    // Configured resources keep their capabilities: no silent model-turn grant.
    expect(isControlCompatible(configured, 'dsh')).toBe(false);
    expect(
      connectionOf({
        ...configured,
        id: resourceId('y'),
        runtime: { adapter: adapterId('pi'), locality: 'remote' },
      }),
    ).toBeDefined();
  });
});

async function localEndpoint(
  id: string,
  kind: 'ollama' | 'openai-compatible',
  toolCalling: boolean,
): Promise<ResourceDescriptor> {
  const { localEndpointDiscoverySource } = await import('@nexar/integration-pi');
  const body = kind === 'ollama' ? { models: [{ name: 'm' }] } : { data: [{ id: 'm' }] };
  const found = await localEndpointDiscoverySource({
    endpoints: [{ id, kind, baseUrl: 'http://127.0.0.1:9', toolCalling }],
    fetch: () => Promise.resolve(new Response(JSON.stringify(body))),
  }).discover(ctx);
  return found[0]!;
}
