import { open } from 'node:fs/promises';
import {
  SandboxLauncher,
  checkSandboxAvailability,
  runSandboxSelfTest,
  type SandboxAvailability,
} from '@nexar/sandbox';
import { PlanCatalog } from '@nexar/engineering';
import { PLAN_ID_PATTERN, PROJECT_ID_PATTERN, type PlaneReadiness } from '@nexar/plane-protocol';
import type { LoadedConfig } from '@nexar/core';
import type { CliSeams } from './args.js';
import { builtinEngineeringPlansDir } from './composition.js';
import type { CliIo } from './io.js';

export const WSL_CONF_PATH = '/etc/wsl.conf';
export const OSRELEASE_PATH = '/proc/sys/kernel/osrelease';
const MAX_WSL_CONF_BYTES = 64 * 1024;
const MAX_KERNEL_CHARS = 200;
const MAX_PLANS = 32;
const MAX_PROJECTS = 200;

export type Toggle = 'disabled' | 'enabled' | 'unknown';

/**
 * Reads `[automount] enabled` and `[interop] enabled` from `wsl.conf` text. A key that is absent
 * keeps WSL's default (enabled); an unparseable value is `unknown`. The text is never returned.
 */
export function parseWslConf(text: string): { automount: Toggle; interop: Toggle } {
  const result: { automount: Toggle; interop: Toggle } = {
    automount: 'enabled',
    interop: 'enabled',
  };
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[([^\]]*)\]\s*(?:[#;].*)?$/.exec(line);
    if (header !== null) {
      section = (header[1] ?? '').trim().toLowerCase();
      continue;
    }
    if (section !== 'automount' && section !== 'interop') continue;
    const eq = line.indexOf('=');
    if (eq < 0 || line.slice(0, eq).trim().toLowerCase() !== 'enabled') continue;
    const value = line
      .slice(eq + 1)
      .replace(/\s+#.*$/, '')
      .trim()
      .replace(/^(["'])(.*)\1$/, '$2')
      .toLowerCase();
    result[section] = value === 'true' ? 'enabled' : value === 'false' ? 'disabled' : 'unknown';
  }
  return result;
}

/** At most `maxBytes` of a host file as text, or `undefined` when it cannot be read. */
export async function readBoundedText(path: string, maxBytes: number): Promise<string | undefined> {
  try {
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/** The kernel release, control characters removed and cut to a bound; `unknown` on any failure. */
export function kernelString(text: string | undefined): string {
  const clean = (text ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim();
  return clean === '' ? 'unknown' : clean.slice(0, MAX_KERNEL_CHARS);
}

async function sandboxState(
  loaded: LoadedConfig,
  seams: CliSeams,
): Promise<Pick<PlaneReadiness, 'sandbox' | 'selftest'>> {
  let availability: SandboxAvailability;
  try {
    availability = await (seams.sandbox?.availability ?? checkSandboxAvailability)();
  } catch {
    return { sandbox: 'unavailable', selftest: 'skipped' };
  }
  if (!availability.available) return { sandbox: 'unavailable', selftest: 'skipped' };
  try {
    const launcher = new SandboxLauncher({
      toolchainPaths: loaded.config.engineering?.toolchainPaths ?? [],
      availability: () => Promise.resolve(availability),
    });
    const results = await (seams.sandbox?.runSelfTest ?? runSandboxSelfTest)(launcher, {
      socatAvailable: availability.socatPath !== undefined,
    });
    const passed = results.length > 0 && results.every((r) => r.passed);
    return { sandbox: 'ok', selftest: passed ? 'pass' : 'fail' };
  } catch {
    return { sandbox: 'ok', selftest: 'fail' };
  }
}

/** The plan ids of the catalog the plane runs from (a seam in tests); `[]` when it cannot be loaded. */
export async function planIds(io: CliIo, seams: CliSeams): Promise<string[]> {
  try {
    const ids =
      seams.plane?.planIds !== undefined
        ? await seams.plane.planIds()
        : (await PlanCatalog.load(builtinEngineeringPlansDir(io))).list().map((plan) => plan.id);
    return ids.filter((id) => PLAN_ID_PATTERN.test(id)).slice(0, MAX_PLANS);
  } catch {
    return [];
  }
}

/** Project ids the Code lane could use: those with engineering settings. */
function projectIds(loaded: LoadedConfig): string[] {
  return loaded.config.projects
    .filter((project) => project.engineering !== undefined)
    .map((project) => project.id)
    .filter((id) => PROJECT_ID_PATTERN.test(id))
    .slice(0, MAX_PROJECTS);
}

/**
 * What the plane verifies about itself at handshake (ADR-025 section 4): sandbox availability and
 * the Nexar self-test, `wsl.conf` hardening, the kernel string, plans and projects. Every probe
 * fails to a safe value; none of them runs a model or reads credentials.
 */
export async function buildReadiness(
  loaded: LoadedConfig,
  io: CliIo,
  seams: CliSeams,
): Promise<PlaneReadiness> {
  const readText = seams.plane?.readText ?? readBoundedText;
  const [sandbox, conf, release, plans] = await Promise.all([
    sandboxState(loaded, seams),
    readText(WSL_CONF_PATH, MAX_WSL_CONF_BYTES),
    readText(OSRELEASE_PATH, MAX_KERNEL_CHARS * 2),
    planIds(io, seams),
  ]);
  const toggles =
    conf === undefined
      ? ({ automount: 'unknown', interop: 'unknown' } as const)
      : parseWslConf(conf);
  return {
    ...sandbox,
    automount: toggles.automount,
    interop: toggles.interop,
    kernel: kernelString(release),
    plans,
    projects: projectIds(loaded),
  };
}
