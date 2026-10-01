import { describe, expect, it } from 'vitest';
import { DeterministicRoutingPolicy, ResourceIntelligencePolicy } from '@nexar/resource-controller';
import { InMemoryTelemetrySink } from '@nexar/telemetry';
import { EchoExecutionAdapter, echoResource } from '@nexar/integration-echo';
import { parseConfig } from './config.js';
import { createNexar } from './create-nexar.js';

function runtime(policy: 'deterministic' | 'resource-intelligence', weights?: object) {
  const config = parseConfig(
    {
      version: 1,
      resources: [echoResource()],
      routing: {
        policy,
        defaultResourceId: 'local-echo',
        ...(weights === undefined ? {} : { resourceIntelligence: { weights } }),
      },
    },
    'test',
  );
  const sink = new InMemoryTelemetrySink();
  return {
    ...createNexar(config, { adapters: [new EchoExecutionAdapter()], telemetry: sink }),
    sink,
  };
}

describe('policy selection and the routing record', () => {
  it('keeps deterministic@1 as the default and records no config id', async () => {
    const r = runtime('deterministic');
    expect(r.policy).toBeInstanceOf(DeterministicRoutingPolicy);
    await r.nexar.run(r.nexar.createTask({ kind: 'general', prompt: 'hi' }));
    const routing = r.sink.records()[0]?.routing;
    expect(routing).toMatchObject({ policy: 'deterministic', policyVersion: '1' });
    expect(routing).not.toHaveProperty('configId');
    expect(routing).not.toHaveProperty('fallback');
  });

  it('selects resource-intelligence@1 from config and records its config id', async () => {
    const r = runtime('resource-intelligence');
    expect(r.policy).toBeInstanceOf(ResourceIntelligencePolicy);
    const configId = r.policy.configId;
    expect(configId).toMatch(/^[0-9a-f]{12}$/);
    await r.nexar.run(r.nexar.createTask({ kind: 'general', prompt: 'hi' }));
    expect(r.sink.records()[0]?.routing).toMatchObject({
      policy: 'resource-intelligence',
      policyVersion: '1',
      configId,
    });
  });

  it('derives a different config id when a weight changes', () => {
    const a = runtime('resource-intelligence').policy.configId;
    const b = runtime('resource-intelligence', { success: 0.5 }).policy.configId;
    expect(a).not.toBe(b);
  });
});
