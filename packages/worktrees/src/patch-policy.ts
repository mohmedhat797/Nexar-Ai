import type { ParsedPatch, PatchEntry, PatchPolicy, PatchValidation, Violation } from './types.js';
import { DEFAULT_MAX_PATCH_BYTES } from './util.js';

const DEFAULT_MAX_FILES = 1000;
const NEW_FILE_MODES: ReadonlySet<string> = new Set(['100644', '100755']);

/** Case-folds and drops trailing dots/spaces, so `.GIT`, `.git.` and `.git ` all equal `.git`. */
function normalizeSegment(segment: string): string {
  return segment.toLowerCase().replace(/[. ]+$/, '');
}

function isGitDirName(normalized: string): boolean {
  return normalized === '.git' || /^git~\d+$/.test(normalized);
}

/** Rule ids broken by a repository-relative path. Never returns the path itself. */
function pathRules(path: string): string[] {
  const rules: string[] = [];
  if (path === '') return ['path-empty'];
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) rules.push('path-absolute');
  if (path.includes('\\')) rules.push('path-backslash');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(path)) rules.push('path-control-char');
  const segments = path.split('/');
  const real = path.startsWith('/') ? segments.slice(1) : segments;
  if (real.some((s) => s === '.' || s === '..')) rules.push('path-dot-segment');
  if (real.some((s) => s === '')) rules.push('path-empty-segment');
  const normalized = real.map(normalizeSegment);
  if (normalized.some(isGitDirName)) rules.push('path-dot-git');
  if (normalized.includes('.gitmodules')) rules.push('path-gitmodules');
  if (normalized.includes('.gitattributes')) rules.push('path-gitattributes');
  if (normalized[0] === '.github' && normalized[1] === 'workflows' && normalized.length > 2) {
    rules.push('path-github-workflows');
  }
  return rules;
}

/** Compiles a simple glob (`*`, `**`, `?`) to an anchored regular expression. */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i] as string;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          source += '(?:.*/)?';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += ch.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 's');
}

function entryRules(entry: PatchEntry, policy: PatchPolicy): string[] {
  const rules = pathRules(entry.path);
  const modes = [entry.oldMode, entry.newMode];
  if (modes.includes('160000')) rules.push('gitlink');
  if (modes.includes('120000') && policy.allowSymlinks !== true) rules.push('symlink');
  if (
    entry.status === 'modified' &&
    entry.oldMode !== undefined &&
    entry.newMode !== undefined &&
    entry.oldMode !== entry.newMode &&
    policy.allowModeChanges !== true
  ) {
    rules.push('mode-change');
  }
  if (
    entry.status === 'added' &&
    (entry.newMode === undefined ||
      (!NEW_FILE_MODES.has(entry.newMode) &&
        entry.newMode !== '160000' &&
        entry.newMode !== '120000'))
  ) {
    rules.push('new-file-mode');
  }
  return rules;
}

/**
 * Applies Nexar's patch policy. Rules ids are stable and carry no paths; the non-path rules
 * (`gitlink`, `symlink`, ...) and every path rule except `deny-glob` cannot be disabled.
 */
export function validatePatch(parsed: ParsedPatch, policy: PatchPolicy = {}): PatchValidation {
  const violations: Violation[] = [];
  const maxBytes = policy.maxBytes ?? DEFAULT_MAX_PATCH_BYTES;
  const maxFiles = policy.maxFiles ?? DEFAULT_MAX_FILES;
  if (parsed.entries.length === 0) violations.push({ rule: 'empty', index: -1 });
  if (parsed.bytes > maxBytes) violations.push({ rule: 'too-large', index: -1 });
  if (parsed.entries.length > maxFiles) violations.push({ rule: 'too-many-files', index: -1 });
  const denied = (policy.denyGlobs ?? []).map(globToRegExp);
  parsed.entries.forEach((entry, index) => {
    for (const rule of entryRules(entry, policy)) violations.push({ rule, index });
    if (denied.some((re) => re.test(entry.path))) violations.push({ rule: 'deny-glob', index });
  });
  if (violations.length > 0) return { ok: false, violations };
  return { ok: true, entries: parsed.entries, bytes: parsed.bytes, sha256: parsed.sha256 };
}
