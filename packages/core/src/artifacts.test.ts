import { describe, expect, it } from 'vitest';
import {
  projectId,
  resourceId,
  taskId,
  type ArtifactRef,
  type Logger,
  type TelemetrySink,
} from '@nexar/contracts';
import { EchoExecutionAdapter, echoResource } from '@nexar/integration-echo';
import { InMemoryTelemetrySink, noopLogger } from '@nexar/telemetry';
import { parseConfig } from './config.js';
import { createNexar } from './create-nexar.js';
import { recordArtifacts } from './engine.js';

const base = {
  version: 1,
  resources: [echoResource({ id: resourceId('local-echo') })],
  routing: { policy: 'deterministic', defaultResourceId: 'local-echo' },
};

describe('config: artifactsDirectory', () => {
  const parse = (extra: Record<string, unknown>) =>
    parseConfig(
      { ...base, projects: [{ id: 'demo', displayName: 'Demo', roots: ['work'], ...extra }] },
      'test',
      { baseDir: '/cfg' },
    );

  it('is optional and kept as a relative path', () => {
    expect(parse({}).projects[0]).not.toHaveProperty('artifactsDirectory');
    expect(parse({ artifactsDirectory: 'out/docs' }).projects[0]?.artifactsDirectory).toBe(
      'out/docs',
    );
    expect(parse({ artifactsDirectory: 'a/../b' }).projects[0]?.artifactsDirectory).toBe('a/../b');
  });

  it.each(['..', '../x', 'a/../..', '/abs/path', '.', 'a/..', 'C:\\x'])('rejects %s', (bad) => {
    expect(() => parse({ artifactsDirectory: bad })).toThrowError(
      expect.objectContaining({ code: 'CONFIGURATION_ERROR' }) as Error,
    );
  });
});

describe('Nexar.recordArtifacts', () => {
  const refs: readonly ArtifactRef[] = [
    { uri: 'file:///w/.nexar/artifacts/t/sow.md', mediaType: 'text/markdown', sha256: 'ab' },
  ];

  it('emits an artifacts.stored event with refs only', async () => {
    const sink = new InMemoryTelemetrySink();
    const { nexar } = createNexar(parseConfig(base, 'test'), {
      adapters: [new EchoExecutionAdapter()],
      telemetry: sink,
    });
    await nexar.recordArtifacts(taskId('t1'), projectId('demo'), refs);
    await recordArtifacts(nexar, taskId('t2'), undefined, refs);
    expect(sink.events).toMatchObject([
      { type: 'artifacts.stored', taskId: 't1', projectId: 'demo', artifacts: refs },
      { type: 'artifacts.stored', taskId: 't2', artifacts: refs },
    ]);
    expect(sink.events[1]).not.toHaveProperty('projectId');
  });

  it('swallows sink failures like other telemetry', async () => {
    const warnings: string[] = [];
    const logger: Logger = { ...noopLogger, warn: (message) => void warnings.push(message) };
    const failing: TelemetrySink = {
      emit: () => {
        throw new Error('disk full');
      },
    };
    const { nexar } = createNexar(parseConfig(base, 'test'), {
      adapters: [new EchoExecutionAdapter()],
      telemetry: failing,
      logger,
    });
    await expect(nexar.recordArtifacts(taskId('t1'), undefined, refs)).resolves.toBeUndefined();
    expect(warnings).toEqual(['telemetry sink failed']);
  });
});
