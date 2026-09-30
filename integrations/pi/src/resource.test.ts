import { describe, expect, it } from 'vitest';
import { PI_ADAPTER_ID, PiExecutionAdapter, piModelResource } from './index.js';

describe('piModelResource', () => {
  it('builds a remote api-key model descriptor with defaults', () => {
    const resource = piModelResource({
      id: 'claude-sonnet',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
    });
    expect(resource).toEqual({
      id: 'claude-sonnet',
      displayName: 'anthropic/claude-sonnet-4-5',
      kind: { type: 'model', provider: 'anthropic', model: 'claude-sonnet-4-5', access: 'api' },
      capabilities: ['text-generation', 'reasoning', 'knowledge-work'],
      runtime: { adapter: PI_ADAPTER_ID, locality: 'remote' },
      auth: { mode: 'api-key', credential: { source: 'env', name: 'ANTHROPIC_API_KEY' } },
      cost: { model: 'unknown' },
      dataLocality: 'third-party',
    });
    expect(new PiExecutionAdapter().supports(resource)).toBe(true);
  });

  it('marks loopback endpoints as local access and local data', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      const resource = piModelResource({
        id: 'llama',
        provider: 'ollama',
        model: 'llama3',
        baseUrl: `http://${host}:11434/v1`,
        contextWindowTokens: 8192,
        capabilities: ['text-generation'],
      });
      expect(resource.kind).toMatchObject({ access: 'local' });
      expect(resource.runtime).toMatchObject({
        locality: 'local',
        options: { baseUrl: `http://${host}:11434/v1` },
      });
      expect(resource.dataLocality).toBe('local');
      expect(resource.auth).toEqual({ mode: 'none' });
      expect(resource.limits).toEqual({ contextWindowTokens: 8192 });
      expect(resource.capabilities).toEqual(['text-generation']);
    }
  });

  it('keeps remote OpenAI-compatible endpoints third-party', () => {
    const resource = piModelResource({
      id: 'gw',
      provider: 'gateway',
      model: 'm',
      baseUrl: 'https://llm.example.com/v1',
    });
    expect(resource.kind).toMatchObject({ access: 'local' });
    expect(resource.dataLocality).toBe('third-party');
  });

  it('rejects invalid resource ids', () => {
    expect(() => piModelResource({ id: 'Bad Id', provider: 'p', model: 'm' })).toThrow();
  });
});
