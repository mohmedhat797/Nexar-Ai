import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NexarError } from '@nexar/contracts';
import { parseConfig } from './config.js';

const resource = (id: string) => ({
  id,
  displayName: id,
  kind: { type: 'model', provider: 'nexar', model: 'echo', access: 'local' },
  capabilities: ['text-generation'],
  runtime: { adapter: 'echo', locality: 'local' },
  auth: { mode: 'none' },
  cost: { model: 'free' },
  dataLocality: 'local',
});

function config(engineering?: unknown, global?: unknown) {
  return {
    version: 1,
    resources: [resource('codex'), resource('claude-code')],
    projects: [
      {
        id: 'demo',
        displayName: 'Demo',
        roots: ['work', 'other'],
        ...(engineering === undefined ? {} : { engineering }),
      },
    ],
    ...(global === undefined ? {} : { engineering: global }),
  };
}

function problem(json: unknown): string {
  try {
    parseConfig(json, 'test', { baseDir: '/base' });
  } catch (error) {
    expect(error).toBeInstanceOf(NexarError);
    expect(error).toMatchObject({ code: 'CONFIGURATION_ERROR' });
    return (error as Error).message;
  }
  throw new Error('expected parseConfig to throw');
}

describe('project engineering settings', () => {
  it('applies every default and resolves the repository against the FIRST root', () => {
    const parsed = parseConfig(config({}), 'test', { baseDir: '/base' });
    expect(parsed.projects[0]?.engineering).toEqual({
      repository: '/base/work',
      baseBranch: 'main',
      setup: [],
      setupAllowHosts: [],
      gates: [],
      laneTimeoutMs: 1_800_000,
      maxReworkRounds: 1,
      reviewDiversity: 'preferred',
      ownerApproval: 'always',
      lanePreferences: {},
      patchPolicy: {
        denyGlobs: [],
        allowSymlinks: false,
        allowModeChanges: false,
        maxBytes: 5_242_880,
      },
    });
    expect(parsed.engineering).toBeUndefined();
  });

  it('resolves a relative repository against the first root, not the second', () => {
    const parsed = parseConfig(config({ repository: 'repo/sub' }), 'test', { baseDir: '/base' });
    expect(parsed.projects[0]?.engineering?.repository).toBe(resolve('/base/work', 'repo/sub'));
  });

  it('accepts a full configuration', () => {
    const parsed = parseConfig(
      config({
        repository: '.',
        baseBranch: 'develop',
        setup: [{ name: 'install', command: ['npm', 'ci', '--offline'], timeoutMs: 1000 }],
        setupAllowHosts: ['registry.npmjs.org'],
        gates: [{ name: 'test', command: ['node', '--test'] }],
        laneTimeoutMs: 5000,
        maxReworkRounds: 3,
        reviewDiversity: 'required',
        ownerApproval: 'never',
        lanePreferences: { feature: ['codex'], review: ['claude-code'] },
        patchPolicy: { denyGlobs: ['secrets/**'], maxBytes: 1024 },
      }),
      'test',
      { baseDir: '/base' },
    );
    const eng = parsed.projects[0]?.engineering;
    expect(eng?.gates).toEqual([{ name: 'test', command: ['node', '--test'], timeoutMs: 600_000 }]);
    expect(eng?.lanePreferences).toEqual({ feature: ['codex'], review: ['claude-code'] });
    expect(eng?.patchPolicy).toEqual({
      denyGlobs: ['secrets/**'],
      allowSymlinks: false,
      allowModeChanges: false,
      maxBytes: 1024,
    });
    expect(eng?.maxReworkRounds).toBe(3);
  });

  it.each([
    ['a shell string as command', { gates: [{ name: 'test', command: 'npm test' }] }],
    ['an empty command', { gates: [{ name: 'test', command: [] }] }],
    ['an empty argv element', { gates: [{ name: 'test', command: ['npm', ''] }] }],
    ['maxReworkRounds above 3', { maxReworkRounds: 4 }],
    ['negative maxReworkRounds', { maxReworkRounds: -1 }],
    ['an unknown reviewDiversity', { reviewDiversity: 'maybe' }],
    ['an unknown ownerApproval', { ownerApproval: 'sometimes' }],
    ['an unknown key', { push: true }],
    ['an unknown lane role', { lanePreferences: { deploy: ['codex'] } }],
    ['an unsafe command name', { gates: [{ name: '../x', command: ['a'] }] }],
    ['an unknown patchPolicy key', { patchPolicy: { allowAll: true } }],
  ])('rejects %s', (_name, engineering) => {
    problem(config(engineering));
  });

  it('rejects lane preferences that name an unknown resource', () => {
    expect(problem(config({ lanePreferences: { review: ['ghost'] } }))).toMatch(
      /lanePreferences\.review references unknown resource "ghost"/,
    );
  });
});

describe('global engineering settings', () => {
  it('applies defaults', () => {
    const parsed = parseConfig(config(undefined, {}), 'test', { baseDir: '/base' });
    expect(parsed.engineering).toEqual({
      toolchainPaths: [],
      author: { name: 'Nexar', email: 'nexar@localhost' },
      approvalTtlMs: 1_800_000,
    });
  });

  it('expands ~ and resolves relative paths against the config directory', () => {
    const parsed = parseConfig(
      config(undefined, {
        worktreesDir: '~/.local/share/nexar/worktrees',
        toolchainPaths: ['/opt/node22', 'tools'],
        author: { name: 'Bot', email: 'bot@example.invalid' },
        approvalTtlMs: 60_000,
      }),
      'test',
      { baseDir: '/base' },
    );
    expect(parsed.engineering).toEqual({
      worktreesDir: join(homedir(), '.local/share/nexar/worktrees'),
      toolchainPaths: ['/opt/node22', '/base/tools'],
      author: { name: 'Bot', email: 'bot@example.invalid' },
      approvalTtlMs: 60_000,
    });
  });

  it('rejects unknown keys and bad values', () => {
    problem(config(undefined, { token: 'x' }));
    problem(config(undefined, { approvalTtlMs: 0 }));
    problem(config(undefined, { author: { name: 'x' } }));
  });
});
