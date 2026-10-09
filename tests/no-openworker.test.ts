import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ADR-030 decision 8: OpenWorker is not a runtime any more. No active path may reference it; the only
// exceptions are literals that let Nexar still READ data written by older builds.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCANNED = /^(apps|packages|integrations)\//;
const SKIPPED_BINARY = /\.(png|ico|icns|jpe?g|gif|woff2?|ttf|zip|db|sqlite)$/i;

/** file -> the exact legacy-read literals allowed in it. Anything else matching /openworker/i fails. */
export const LEGACY_READ_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  // Persisted turn lanes (`engine`) written before DeepSeek Harness ran Cowork.
  'packages/sessions/src/record.ts': ["'openworker'"],
  'packages/sessions/src/transitions.ts': ["'openworker'"],
  'packages/sessions/src/types.ts': ["'openworker'"],
  'packages/plane-protocol/src/schemas.ts': ["'openworker'", 'openworker: z.boolean().optional()'],
  'apps/desktop/src/shared/api.ts': ["'openworker'"],
  // Fallback reasons and the lane label of turns recorded before the migration.
  'apps/desktop/src/renderer/code.ts': [
    "'openworker-unavailable'",
    "'openworker-control-unavailable'",
    'OpenWorker unavailable (retired)',
    'OpenWorker (retired)',
  ],
  // Legacy-read tests: they feed old records to the readers above.
  'apps/desktop/src/renderer/code.test.ts': [
    "'openworker-unavailable'",
    "'openworker-control-unavailable'",
    'OpenWorker unavailable (retired)',
  ],
  'packages/sessions/src/record.test.ts': ["'openworker'", "'openworker-unavailable'"],
};

export interface Violation {
  readonly file: string;
  readonly line: number;
}

/** Lines of `text` that still mention OpenWorker once the file's allowlisted literals are removed. */
export function findViolations(
  file: string,
  text: string,
  allowlist: Readonly<Record<string, readonly string[]>> = LEGACY_READ_ALLOWLIST,
): Violation[] {
  const allowed = allowlist[file] ?? [];
  const violations: Violation[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    let line = raw;
    for (const literal of allowed) line = line.split(literal).join('');
    if (/openworker/i.test(line)) violations.push({ file, line: index + 1 });
  });
  return violations;
}

function trackedFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return out
    .split('\0')
    .filter((f) => f !== '' && SCANNED.test(f) && !SKIPPED_BINARY.test(f))
    .filter((f) => !f.includes('/node_modules/') && !f.includes('/dist/'));
}

function read(file: string): string | undefined {
  try {
    return readFileSync(join(root, file), 'utf8');
  } catch {
    return undefined; // listed but deleted in the working tree
  }
}

describe('no OpenWorker runtime (ADR-030)', () => {
  const files = trackedFiles();

  it('scans the source trees', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('has no reference outside the legacy-read allowlist', () => {
    const violations = files.flatMap((file) => {
      const text = read(file);
      return text === undefined ? [] : findViolations(file, text);
    });
    expect(violations).toEqual([]);
  });

  it('keeps every allowlist entry alive (a stale entry hides a future re-add)', () => {
    for (const [file, literals] of Object.entries(LEGACY_READ_ALLOWLIST)) {
      const text = read(file);
      if (text === undefined) continue;
      for (const literal of literals) expect(text, `${file}: ${literal}`).toContain(literal);
    }
  });

  it('has no package.json depending on an OpenWorker package', () => {
    const manifests = ['package.json', ...files.filter((f) => f.endsWith('/package.json'))];
    for (const manifest of manifests) {
      const json = JSON.parse(read(manifest) ?? '{}') as Record<string, unknown>;
      for (const key of [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
      ]) {
        const names = Object.keys(json[key] ?? {});
        expect(
          names.filter((n) => /openworker/i.test(n)),
          `${manifest} ${key}`,
        ).toEqual([]);
      }
    }
  });

  it('spawns no openworker-server', () => {
    const spawners = files.filter((f) => /openworker-server/i.test(read(f) ?? ''));
    expect(spawners).toEqual([]);
  });

  describe('detector', () => {
    it('flags a re-added reference, in any case', () => {
      expect(findViolations('apps/x.ts', "import 'openworker-server';\nfoo")).toEqual([
        { file: 'apps/x.ts', line: 1 },
      ]);
      expect(findViolations('apps/x.ts', 'a\nb\n// OpenWorker bridge', {})).toEqual([
        { file: 'apps/x.ts', line: 3 },
      ]);
    });

    it('allows only the exact literal in the listed file', () => {
      const allow = { 'a.ts': ["'openworker'"] };
      expect(findViolations('a.ts', "engine: 'openworker'", allow)).toEqual([]);
      expect(findViolations('a.ts', "engine: 'openworker-server'", allow)).toHaveLength(1);
      expect(findViolations('b.ts', "engine: 'openworker'", allow)).toHaveLength(1);
    });
  });
});
