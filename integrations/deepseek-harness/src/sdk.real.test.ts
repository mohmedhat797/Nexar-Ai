import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adapterId } from '@nexar/contracts';
import { DeepSeekHarnessExecutionAdapter } from './adapter.js';
import { deepseekHarnessResource } from './resource.js';
import { makeContext, makeTask, makeTempDir, type LogLine } from './test/support.js';

const entry = process.env['NEXAR_DSH_ENTRY'];

// The managed SDK path is retained for ordinary adapter tasks. Only a local synthetic provider
// is used; no real API credential, account, paid request or owner's DSH home participates.
describe.skipIf(entry === undefined)('managed DSH SDK compatibility', () => {
  it('executes through the explicit synthetic provider without activating the new tool surface', async () => {
    const dir = makeTempDir('nexar-dsh-sdk-real-');
    const key = 'SYNTHETIC_SDK_FIXTURE_CREDENTIAL';
    const requests: { authorization: string | undefined; body: Record<string, unknown> }[] = [];
    const logs: LogLine[] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        requests.push({
          authorization: request.headers.authorization,
          body: JSON.parse(body) as Record<string, unknown>,
        });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (delta: object, finishReason: string | null) =>
          JSON.stringify({
            id: 'synthetic-sdk-response',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'fixture-model',
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          });
        response.end(
          `data: ${chunk({ role: 'assistant', content: 'Synthetic SDK result' }, null)}\n\ndata: ${chunk({}, 'stop')}\n\ndata: [DONE]\n\n`,
        );
      });
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
      const patch = join(dir, 'synthetic-provider.patch.yml');
      await writeFile(
        patch,
        [
          '- id: llm-pi-ai',
          '  config:',
          '    providers:',
          '      fixture:',
          '        api: openai-completions',
          `        baseURL: ${JSON.stringify(baseURL)}`,
          '        apiKeyEnv: SDK_FIXTURE_KEY',
          '        models:',
          '          - id: fixture-model',
          '',
        ].join('\n'),
        { mode: 0o600 },
      );
      const home = join(dir, 'owned-home');
      await mkdir(home);
      const stateDir = join(dir, 'state');
      const runtimeHome = join(stateDir, 'home');
      await mkdir(runtimeHome, { recursive: true, mode: 0o700 });
      // An upstream saved credential must never replace Nexar's explicitly selected key.
      await writeFile(
        join(runtimeHome, '.credentials.yaml'),
        'version: 1\nrefs:\n  SDK_FIXTURE_KEY: foreign-fixture\n',
        { mode: 0o600 },
      );
      const adapter = new DeepSeekHarnessExecutionAdapter({
        binary: { command: process.execPath, args: [entry!] },
        stateDir,
        env: { PATH: process.env.PATH, HOME: home, SDK_FIXTURE_KEY: key },
        initializeTimeoutMs: 60000,
        defaultTimeoutMs: 90000,
      });
      const resource = deepseekHarnessResource({
        auth: { mode: 'api-key', credential: { source: 'env', name: 'SDK_FIXTURE_KEY' } },
        runtime: {
          adapter: adapterId('deepseek-harness'),
          locality: 'local',
          options: {
            provider: 'fixture',
            model: 'fixture-model',
            patches: [patch],
            piAiProviders: { fixture: { apiKeyEnv: 'SDK_FIXTURE_KEY' } },
          },
        },
      });
      const result = await adapter.execute(
        { task: makeTask({ workingDirectory: dir }), resource },
        makeContext({ logs }),
      );
      expect(result.text).toContain('Synthetic SDK result');
      expect(requests).toHaveLength(1);
      expect(requests[0]?.authorization).toBe(`Bearer ${key}`);
      expect(requests[0]?.body['model']).toBe('fixture-model');
      const tools = requests[0]?.body['tools'] as { function?: { name?: string } }[] | undefined;
      const names = (tools ?? []).map((tool) => tool.function?.name);
      expect(names.length).toBeGreaterThan(0);
      expect(names.every((name) => typeof name === 'string')).toBe(true);
      expect(names).not.toContain('working_directory');
      expect(JSON.stringify(logs)).not.toContain(key);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 120000);
});
