import { NexarError } from '@nexar/contracts';
import type { ParsedPatch, PatchEntry } from './types.js';
import { sha256Hex } from './util.js';

const MODE = /^[0-7]{6}$/;
const INDEX = /^index [0-9a-f]{40,64}\.\.[0-9a-f]{40,64}(?: ([0-7]{6}))?$/;
const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?: .*)?$/;
const BINARY_BLOCK = /^(?:literal|delta) \d+$/;
const BASE85_LINE = /^[A-Za-z][0-9A-Za-z!#$%&()*+\-;<=>?@^_`{|}~]*$/;
const DIFF_PREFIX = 'diff --git ';

function reject(message: string): never {
  // Never include the offending line: it contains attacker-chosen paths.
  throw new NexarError('VALIDATION_ERROR', `Malformed patch: ${message}`);
}

const SIMPLE_ESCAPES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
};

/** Reads a C-quoted token starting at `start` (which must be `"`); returns the decoded text and the end index. */
function readQuoted(text: string, start: number): { value: string; end: number } {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  let i = start + 1;
  for (;;) {
    const ch = text[i];
    if (ch === undefined) return reject('unterminated quoted path');
    if (ch === '"') break;
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === undefined) return reject('bad escape');
      const octal = /^[0-3][0-7]{2}/.exec(text.slice(i + 1, i + 4));
      if (octal) {
        bytes.push(parseInt(octal[0], 8));
        i += 4;
      } else {
        const simple = SIMPLE_ESCAPES[next];
        if (simple === undefined) return reject('bad escape');
        bytes.push(simple);
        i += 2;
      }
    } else {
      const cp = text.codePointAt(i) as number;
      const char = String.fromCodePoint(cp);
      bytes.push(...encoder.encode(char));
      i += char.length;
    }
  }
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
    return { value, end: i + 1 };
  } catch {
    return reject('path is not valid UTF-8');
  }
}

/** Parses the `a/P b/P` part of a `diff --git` line; both halves must name the same path. */
function parseDiffLine(rest: string): string {
  if (rest.startsWith('"')) {
    const first = readQuoted(rest, 0);
    if (rest[first.end] !== ' ' || rest[first.end + 1] !== '"') return reject('bad diff header');
    const second = readQuoted(rest, first.end + 1);
    if (second.end !== rest.length) return reject('bad diff header');
    if (!first.value.startsWith('a/') || !second.value.startsWith('b/')) {
      return reject('bad diff header');
    }
    if (first.value.slice(2) !== second.value.slice(2)) return reject('path mismatch');
    return first.value.slice(2);
  }
  if (!rest.startsWith('a/') || (rest.length - 5) % 2 !== 0 || rest.length < 7) {
    return reject('bad diff header');
  }
  const length = (rest.length - 5) / 2;
  const path = rest.slice(2, 2 + length);
  if (rest !== `a/${path} b/${path}`) return reject('path mismatch');
  return path;
}

/** Parses a `---`/`+++` file name: `/dev/null`, or an `a/`/`b/` prefixed (maybe quoted) path. */
function parseFileLine(rest: string, prefix: 'a/' | 'b/'): string | null {
  const text = rest.endsWith('\t') ? rest.slice(0, -1) : rest;
  if (text === '/dev/null') return null;
  if (text.startsWith('"')) {
    const quoted = readQuoted(text, 0);
    if (quoted.end !== text.length || !quoted.value.startsWith(prefix)) {
      return reject('bad file header');
    }
    return quoted.value.slice(2);
  }
  if (!text.startsWith(prefix)) return reject('bad file header');
  return text.slice(2);
}

interface Draft {
  path: string;
  isNew: boolean;
  isDeleted: boolean;
  oldMode?: string;
  newMode?: string;
  indexMode?: string;
  sawIndex: boolean;
  binary: boolean;
}

function finish(draft: Draft): PatchEntry {
  const status = draft.isNew ? 'added' : draft.isDeleted ? 'deleted' : 'modified';
  let oldMode = draft.oldMode;
  let newMode = draft.newMode;
  if (status === 'modified' && oldMode === undefined && draft.indexMode !== undefined) {
    oldMode = draft.indexMode;
    newMode = draft.indexMode;
  }
  return {
    path: draft.path,
    status,
    ...(oldMode === undefined ? {} : { oldMode }),
    ...(newMode === undefined ? {} : { newMode }),
    binary: draft.binary,
  };
}

/**
 * Parses `git diff --binary --full-index --no-renames` output (run with `core.quotePath=true`).
 * Fail closed: anything not produced by that command throws `VALIDATION_ERROR`, and error
 * messages never contain paths.
 */
export function parsePatch(input: string | Uint8Array): ParsedPatch {
  const raw = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const text = typeof input === 'string' ? input : new TextDecoder('utf-8').decode(input);
  const result: PatchEntry[] = [];
  const done = (): ParsedPatch => ({
    entries: result,
    bytes: raw.length,
    sha256: sha256Hex(raw),
  });
  if (text.length === 0) return done();
  if (!text.endsWith('\n')) return reject('missing trailing newline');

  const lines = text.split('\n');
  lines.pop();

  let draft: Draft | undefined;
  // 'header' → extended headers; 'files' → saw ---, expect +++; 'hunks' → text hunks;
  // 'binary' → inside a GIT binary patch; 'between' → after a binary block's blank line.
  let state: 'header' | 'files' | 'hunks' | 'binary' | 'between' = 'header';
  let sawOld = false;
  let sawNew = false;
  let hunks = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let inBinaryBlock = false;
  let binaryBlocks = 0;
  let hunkLines = 0;

  const flush = (entry: Draft): void => {
    if (state === 'files') return reject('truncated file header');
    if (state === 'hunks' && (hunks === 0 || oldLeft !== 0 || newLeft !== 0)) {
      return reject('truncated hunk');
    }
    if (state === 'binary' && (inBinaryBlock || binaryBlocks === 0)) {
      return reject('truncated binary patch');
    }
    if (sawOld !== sawNew) return reject('incomplete file headers');
    if (!entry.isDeleted && entry.oldMode !== undefined && entry.newMode === undefined) {
      return reject('incomplete mode change');
    }
    result.push(finish(entry));
  };

  for (const line of lines) {
    if (line.startsWith(DIFF_PREFIX)) {
      if (draft !== undefined) flush(draft);
      draft = {
        path: parseDiffLine(line.slice(DIFF_PREFIX.length)),
        isNew: false,
        isDeleted: false,
        sawIndex: false,
        binary: false,
      };
      state = 'header';
      sawOld = false;
      sawNew = false;
      hunks = 0;
      oldLeft = 0;
      newLeft = 0;
      inBinaryBlock = false;
      binaryBlocks = 0;
      hunkLines = 0;
      continue;
    }
    if (draft === undefined) return reject('content before the first diff header');

    if (state === 'hunks') {
      if (oldLeft > 0 || newLeft > 0) {
        const mark = line[0];
        if (mark === ' ') {
          oldLeft -= 1;
          newLeft -= 1;
        } else if (mark === '-') {
          oldLeft -= 1;
        } else if (mark === '+') {
          newLeft -= 1;
        } else if (mark !== '\\') {
          return reject('bad hunk line');
        }
        if (oldLeft < 0 || newLeft < 0) return reject('hunk overrun');
        if (mark !== '\\') hunkLines += 1;
        continue;
      }
      if (line.startsWith('\\') && hunkLines > 0) continue;
      const hunk = HUNK.exec(line);
      if (!hunk) return reject('unexpected line after hunk');
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      hunks += 1;
      hunkLines = 0;
      continue;
    }

    if (state === 'binary' || state === 'between') {
      if (inBinaryBlock) {
        if (line === '') {
          inBinaryBlock = false;
          state = 'between';
        } else if (!BASE85_LINE.test(line)) {
          return reject('bad binary data');
        }
        continue;
      }
      if (BINARY_BLOCK.test(line) && binaryBlocks < 2) {
        inBinaryBlock = true;
        binaryBlocks += 1;
        state = 'binary';
        continue;
      }
      return reject('unexpected line after binary patch');
    }

    if (state === 'files') {
      if (!line.startsWith('+++ ')) return reject('expected +++ header');
      const target = parseFileLine(line.slice(4), 'b/');
      if (draft.isDeleted ? target !== null : draft.path !== target) {
        return reject('path mismatch');
      }
      sawNew = true;
      state = 'hunks';
      continue;
    }

    // state === 'header'
    if (line.startsWith('new file mode ')) {
      const mode = line.slice('new file mode '.length);
      if (!MODE.test(mode) || draft.isNew || draft.isDeleted || draft.oldMode !== undefined) {
        return reject('bad new file mode');
      }
      draft.isNew = true;
      draft.newMode = mode;
    } else if (line.startsWith('deleted file mode ')) {
      const mode = line.slice('deleted file mode '.length);
      if (!MODE.test(mode) || draft.isNew || draft.isDeleted || draft.oldMode !== undefined) {
        return reject('bad deleted file mode');
      }
      draft.isDeleted = true;
      draft.oldMode = mode;
    } else if (line.startsWith('old mode ')) {
      const mode = line.slice('old mode '.length);
      if (!MODE.test(mode) || draft.isNew || draft.isDeleted || draft.oldMode !== undefined) {
        return reject('bad old mode');
      }
      draft.oldMode = mode;
    } else if (line.startsWith('new mode ')) {
      const mode = line.slice('new mode '.length);
      if (!MODE.test(mode) || draft.isNew || draft.isDeleted || draft.oldMode === undefined) {
        return reject('bad new mode');
      }
      if (draft.newMode !== undefined) return reject('duplicate new mode');
      draft.newMode = mode;
    } else if (line.startsWith('index ')) {
      const match = INDEX.exec(line);
      if (!match || draft.sawIndex) return reject('bad index line');
      draft.sawIndex = true;
      if (match[1] !== undefined) draft.indexMode = match[1];
    } else if (line.startsWith('--- ')) {
      const source = parseFileLine(line.slice(4), 'a/');
      if (draft.isNew ? source !== null : draft.path !== source) return reject('path mismatch');
      sawOld = true;
      state = 'files';
    } else if (line === 'GIT binary patch') {
      draft.binary = true;
      state = 'binary';
    } else if (line.startsWith('Binary files ')) {
      return reject('binary change without --binary');
    } else {
      return reject('unexpected header line');
    }
  }
  if (draft !== undefined) flush(draft);
  return done();
}
