import { execFile } from 'node:child_process';
import { NexarError } from '@nexar/contracts';
import { DSH_PINNED_VERSION } from '@nexar/integration-deepseek-harness';
import type { Command } from '../args.js';
import { compose, loadCliConfig } from '../composition.js';
import { EXIT, type CliIo } from '../io.js';

const MIN_NODE = [22, 19] as const;
const EXTERNAL_TIMEOUT_MS = 5_000;

type Status = 'ok' | 'warn' | 'error' | 'info';

interface Check {
  readonly status: Status;
  readonly name: string;
  readonly detail: string;
}

interface Section {
  readonly id: string;
  readonly title: string;
  readonly checks: readonly Check[];
}

const MARKERS: Record<Status, string> = { ok: '✔', warn: '!', error: '✖', info: '-' };

type CommandResult = { readonly found: true; readonly output: string } | { readonly found: false };

/** Runs `<command> --version` with a minimal env and a hard timeout; never a model call. */
function versionOf(command: string, io: CliIo): Promise<CommandResult> {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'SystemRoot']) {
    const value = io.env[key];
    if (value !== undefined) env[key] = value;
  }
  return new Promise((resolve) => {
    execFile(
      command,
      ['--version'],
      { timeout: EXTERNAL_TIMEOUT_MS, env, cwd: io.cwd, windowsHide: true },
      (error, stdout, stderr) => {
        if (error !== null) return resolve({ found: false });
        const output = `${stdout}${stderr}`.trim().split('\n')[0] ?? '';
        resolve({ found: true, output });
      },
    );
  });
}

function nodeAtLeastMinimum(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

async function runtimeSection(io: CliIo): Promise<Section> {
  const node = process.versions.node;
  const [git, pnpm] = await Promise.all([versionOf('git', io), versionOf('pnpm', io)]);
  const minimum = MIN_NODE.join('.');
  return {
    id: 'runtime',
    title: 'Runtime',
    checks: [
      nodeAtLeastMinimum(node)
        ? { status: 'ok', name: 'node', detail: node }
        : { status: 'error', name: 'node', detail: `${node} (requires >= ${minimum})` },
      git.found
        ? { status: 'ok', name: 'git', detail: git.output }
        : { status: 'error', name: 'git', detail: 'not found' },
      pnpm.found
        ? { status: 'ok', name: 'pnpm', detail: pnpm.output }
        : { status: 'warn', name: 'pnpm', detail: 'not found (optional)' },
    ],
  };
}

async function externalSection(io: CliIo): Promise<Section> {
  const claude = versionOf('claude', io);
  const dsh = versionOf('dsh', io);
  const others = (['codex', 'agy', 'openworker-server'] as const).map(
    async (command): Promise<Check> => {
      const result = await versionOf(command, io);
      const found = result.found ? `found: ${result.output}` : 'not found';
      return { status: 'info', name: command, detail: `not integrated in v0.1 (${found})` };
    },
  );
  const claudeResult = await claude;
  const dshResult = await dsh;
  const checks: Check[] = [
    claudeResult.found
      ? { status: 'ok', name: 'claude', detail: claudeResult.output }
      : { status: 'warn', name: 'claude', detail: 'not found' },
    !dshResult.found
      ? { status: 'warn', name: 'dsh', detail: `not found (pinned ${DSH_PINNED_VERSION})` }
      : dshResult.output.includes(DSH_PINNED_VERSION)
        ? { status: 'ok', name: 'dsh', detail: `${dshResult.output} (matches pinned version)` }
        : {
            status: 'warn',
            name: 'dsh',
            detail: `${dshResult.output} (pinned version is ${DSH_PINNED_VERSION})`,
          },
    ...(await Promise.all(others)),
  ];
  return { id: 'external', title: 'External runtimes (informational)', checks };
}

async function configAndResources(
  ctx: Parameters<Command['run']>[0],
): Promise<readonly [Section, Section]> {
  try {
    const loaded = await loadCliConfig(ctx.io, ctx.configPath);
    const { runtime } = await compose(loaded, ctx.io, ctx.logger);
    const configSection: Section = {
      id: 'config',
      title: 'Config',
      checks: [
        {
          status: 'ok',
          name: 'source',
          detail:
            loaded.path === undefined
              ? `${loaded.source} (built-in)`
              : `${loaded.source}: ${loaded.path}`,
        },
      ],
    };
    const snapshots = await runtime.registry.refresh();
    const checks = snapshots.map((snapshot): Check => {
      const { descriptor, state } = snapshot;
      const adapter = descriptor.runtime.adapter;
      const extra = state.detail === undefined ? '' : ` — ${state.detail}`;
      if (runtime.adapters.get(adapter) === undefined) {
        return {
          status: 'error',
          name: descriptor.id,
          detail: `adapter=${adapter} not installed in this build${extra}`,
        };
      }
      const healthy = state.availability === 'available' && state.auth !== 'unauthenticated';
      return {
        status: healthy ? 'ok' : 'warn',
        name: descriptor.id,
        detail:
          `adapter=${adapter} installed availability=${state.availability} auth=${state.auth}` +
          extra,
      };
    });
    return [configSection, { id: 'resources', title: 'Resources', checks }];
  } catch (error) {
    const message = error instanceof NexarError ? error.message : String(error);
    return [
      {
        id: 'config',
        title: 'Config',
        checks: [{ status: 'error', name: 'config', detail: message }],
      },
      {
        id: 'resources',
        title: 'Resources',
        checks: [{ status: 'info', name: 'resources', detail: 'skipped: no valid config' }],
      },
    ];
  }
}

function render(sections: readonly Section[]): string {
  const lines: string[] = [];
  for (const section of sections) {
    lines.push(section.title);
    for (const check of section.checks) {
      lines.push(`  ${MARKERS[check.status]} ${check.name}: ${check.detail}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export const doctorCommand: Command = {
  name: 'doctor',
  summary: 'Check the runtime, config, resources and external tools (no model calls)',
  usage: 'nexar doctor [--json]',
  options: {},
  async run(ctx) {
    const [runtime, [config, resources], external] = await Promise.all([
      runtimeSection(ctx.io),
      configAndResources(ctx),
      externalSection(ctx.io),
    ]);
    const sections = [runtime, config, resources, external];
    const ok = !sections.some((s) => s.checks.some((c) => c.status === 'error'));
    ctx.io.stdout(ctx.json ? JSON.stringify({ ok, sections }, null, 2) + '\n' : render(sections));
    return ok ? EXIT.ok : EXIT.failure;
  },
};
