import { spawnRuntime } from '@nexar/process';
import { readFile } from 'node:fs/promises';
import { NexarError } from '@nexar/contracts';
import { DSH_PINNED_VERSION } from '@nexar/integration-deepseek-harness';
import { checkSandboxAvailability, type SandboxAvailability } from '@nexar/sandbox';
import type { Command, CliSeams, VersionProbe } from '../args.js';
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

type CommandResult = VersionProbe;
type Probe = (command: string, args?: readonly string[]) => Promise<CommandResult>;

/** Runs `<command> --version` (or `args`) with a minimal env and a hard timeout; never a model call. */
function versionOf(
  command: string,
  io: CliIo,
  args: readonly string[] = ['--version'],
): Promise<CommandResult> {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'HOME',
    'SystemRoot',
    'PATHEXT',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
  ]) {
    const actual =
      process.platform === 'win32'
        ? Object.keys(io.env).find((name) => name.toUpperCase() === key.toUpperCase())
        : key;
    const value = actual === undefined ? undefined : io.env[actual];
    if (value !== undefined) env[key] = value;
  }
  return new Promise((resolve) => {
    try {
      const child = spawnRuntime(command, [...args], {
        timeout: EXTERNAL_TIMEOUT_MS,
        env,
        cwd: io.cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let outputText = '';
      const collect = (chunk: Buffer): void => {
        outputText = (outputText + chunk.toString('utf8')).slice(-8192);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.once('error', () => resolve({ found: false }));
      child.once('close', (code) => {
        if (code !== 0) return resolve({ found: false });
        // The first line that carries a version number (`socat -V` opens with a banner).
        const lines = outputText.trim().split('\n');
        const output = lines.find((line) => /\d+\.\d+/.test(line)) ?? lines[0] ?? '';
        resolve({ found: true, output });
      });
    } catch {
      resolve({ found: false });
    }
  });
}

function nodeAtLeastMinimum(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

async function runtimeSection(probe: Probe): Promise<Section> {
  const node = process.versions.node;
  const [git, pnpm] = await Promise.all([probe('git'), probe('pnpm')]);
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

/** Presence only (`--version`): never a sign-in, never a model call. */
async function presence(probe: Probe, command: string): Promise<Check> {
  const result = await probe(command);
  return result.found
    ? { status: 'ok', name: command, detail: result.output }
    : { status: 'warn', name: command, detail: 'not found' };
}

async function externalSection(probe: Probe): Promise<Section> {
  const claude = presence(probe, 'claude');
  const codex = presence(probe, 'codex');
  const agy = presence(probe, 'agy');
  const dsh = probe('dsh');
  const dshResult = await dsh;
  const checks: Check[] = [
    await claude,
    !dshResult.found
      ? { status: 'warn', name: 'dsh', detail: `not found (pinned ${DSH_PINNED_VERSION})` }
      : dshResult.output.includes(DSH_PINNED_VERSION)
        ? { status: 'ok', name: 'dsh', detail: `${dshResult.output} (matches pinned version)` }
        : {
            status: 'warn',
            name: 'dsh',
            detail: `${dshResult.output} (pinned version is ${DSH_PINNED_VERSION})`,
          },
    await codex,
    await agy,
  ];
  return { id: 'external', title: 'External runtimes (informational)', checks };
}

const WSL_CONF = '/etc/wsl.conf';

/** `[section] key=value` lines; later duplicates win, as in the WSL parser. Keys are lower-cased. */
function parseIni(text: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header !== null) {
      section = (header[1] ?? '').trim().toLowerCase();
      continue;
    }
    const at = line.indexOf('=');
    if (at > 0) {
      values.set(
        `${section}.${line.slice(0, at).trim().toLowerCase()}`,
        line
          .slice(at + 1)
          .trim()
          .toLowerCase(),
      );
    }
  }
  return values;
}

/** The `/etc/wsl.conf` settings ADR-018 requires of the engineering distro. */
const WSL_EXPECTATIONS: readonly (readonly [key: string, expected: string])[] = [
  ['automount.enabled', 'false'],
  ['interop.enabled', 'false'],
  ['interop.appendwindowspath', 'false'],
  ['boot.systemd', 'true'],
];

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function wslChecks(read: (path: string) => Promise<string | undefined>): Promise<Check[]> {
  const version = await read('/proc/version');
  if (version === undefined || !version.toLowerCase().includes('microsoft')) return [];
  const conf = await read(WSL_CONF);
  if (conf === undefined) {
    return [{ status: 'warn', name: 'wsl.conf', detail: `${WSL_CONF} not found (ADR-018)` }];
  }
  const values = parseIni(conf);
  return WSL_EXPECTATIONS.map(([key, expected]): Check => {
    const actual = values.get(key);
    return actual === expected
      ? { status: 'ok', name: `wsl.conf ${key}`, detail: expected }
      : {
          status: 'warn',
          name: `wsl.conf ${key}`,
          detail: `${actual ?? 'unset'} (ADR-018 requires ${expected})`,
        };
  });
}

const AVAILABILITY_TIMEOUT_MS = 1_500;

/** The probe launches a real (tiny) bwrap; a stalled one must not stall `doctor` for its own 10 s. */
async function availabilityWithin(
  probe: () => Promise<SandboxAvailability>,
): Promise<SandboxAvailability> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<SandboxAvailability>((resolve) => {
    timer = setTimeout(
      () => resolve({ available: false, detail: 'the sandbox availability probe timed out' }),
      AVAILABILITY_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([probe(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Availability probe only (no sandbox launch beyond it), AppArmor and, under WSL, `wsl.conf`. */
async function engineeringSection(probe: Probe, seams: CliSeams['doctor']): Promise<Section> {
  const read = seams?.readText ?? readText;
  const [availability, apparmor, wsl] = await Promise.all([
    availabilityWithin(seams?.availability ?? checkSandboxAvailability),
    read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns'),
    wslChecks(read),
  ]);
  // After the availability probe, not beside it: concurrent child processes can stall a bwrap probe.
  const socat = await probe('socat', ['-V']);
  const checks: Check[] = [
    availability.available
      ? {
          status: 'ok',
          name: 'bwrap',
          detail: `${availability.bwrapVersion ?? 'unknown version'} (functional probe passed)`,
        }
      : {
          status: 'warn',
          name: 'bwrap',
          detail: `${availability.detail} (engineering lanes need it; see docs/integration/wsl2-engineering-plane.md)`,
        },
    socat.found
      ? {
          status: 'ok',
          name: 'socat',
          detail: /socat version \S+/i.exec(socat.output)?.[0] ?? 'found',
        }
      : availability.socatPath === undefined
        ? { status: 'warn', name: 'socat', detail: 'not found (needed for lane network access)' }
        : { status: 'ok', name: 'socat', detail: 'found' },
  ];
  if (apparmor !== undefined) {
    const value = apparmor.trim();
    checks.push(
      value === '1'
        ? {
            status: 'warn',
            name: 'kernel.apparmor_restrict_unprivileged_userns',
            detail:
              '1 (bwrap needs an AppArmor profile scoped to it; never set this to 0 globally)',
          }
        : { status: 'info', name: 'kernel.apparmor_restrict_unprivileged_userns', detail: value },
    );
  }
  checks.push(...wsl);
  return { id: 'engineering', title: 'Engineering plane', checks };
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
    const probe: Probe =
      ctx.seams.doctor?.versionOf ?? ((command, args) => versionOf(command, ctx.io, args));
    const [runtime, [config, resources], external, engineering] = await Promise.all([
      runtimeSection(probe),
      configAndResources(ctx),
      externalSection(probe),
      engineeringSection(probe, ctx.seams.doctor),
    ]);
    const sections = [runtime, config, resources, external, engineering];
    const ok = !sections.some((s) => s.checks.some((c) => c.status === 'error'));
    ctx.io.stdout(ctx.json ? JSON.stringify({ ok, sections }, null, 2) + '\n' : render(sections));
    return ok ? EXIT.ok : EXIT.failure;
  },
};
