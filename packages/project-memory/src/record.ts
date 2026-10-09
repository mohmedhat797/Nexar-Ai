import { NexarError } from '@nexar/contracts';
import { z } from 'zod';
import {
  MAX_MEMORY_ENTRIES,
  MAX_MEMORY_TEXT_CHARS,
  MEMORY_ID_PATTERN,
  MEMORY_PROJECT_ID_PATTERN,
  PROJECT_MEMORY_KINDS,
} from './types.js';
import type { ProjectMemoryRecord } from './types.js';

/*
 * Strict, prototype-safe parsing. Anything unexpected fails closed with a generic error: file paths
 * and record content never appear in messages or details.
 */

const SESSION_ID = /^ses_[0-9a-f]{32}$/;
const TURN_ID = /^turn_[0-9a-f]{32}$/;
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export function corruptRecord(): NexarError {
  return new NexarError('VALIDATION_ERROR', 'Project memory record is unreadable', {
    details: { reason: 'corrupt-record' },
  });
}

function hasForbiddenKey(value: unknown, depth = 0): boolean {
  if (depth > 8) return true;
  if (Array.isArray(value)) return value.some((v) => hasForbiddenKey(v, depth + 1));
  if (typeof value !== 'object' || value === null) return false;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) return true;
    if (hasForbiddenKey((value as Record<string, unknown>)[key], depth + 1)) return true;
  }
  return false;
}

/** Trimmed, 1..1000 characters, no control characters except `\n`. */
export function isValidMemoryText(text: string): boolean {
  return (
    text.length >= 1 &&
    text.length <= MAX_MEMORY_TEXT_CHARS &&
    text === text.trim() &&
    !/[\p{Cc}]/u.test(text.replace(/\n/g, ''))
  );
}

const entrySchema = z.strictObject({
  id: z.string().regex(MEMORY_ID_PATTERN),
  kind: z.enum(PROJECT_MEMORY_KINDS),
  text: z.string().refine(isValidMemoryText),
  createdAt: z.iso.datetime(),
  source: z.literal('owner'),
  sessionId: z.string().regex(SESSION_ID).optional(),
  turnId: z.string().regex(TURN_ID).optional(),
});

const recordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectId: z.string().regex(MEMORY_PROJECT_ID_PATTERN),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  entries: z.array(entrySchema).max(MAX_MEMORY_ENTRIES),
});

export function parseRecord(text: string, projectId: string): ProjectMemoryRecord {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw corruptRecord();
  }
  if (hasForbiddenKey(json)) throw corruptRecord();
  const parsed = recordSchema.safeParse(json);
  if (!parsed.success || parsed.data.projectId !== projectId) throw corruptRecord();
  const ids = new Set(parsed.data.entries.map((e) => e.id));
  if (ids.size !== parsed.data.entries.length) throw corruptRecord();
  // Absent optional keys stay absent in JSON; the cast only bridges `exactOptionalPropertyTypes`.
  return parsed.data as ProjectMemoryRecord;
}

export function serializeRecord(record: ProjectMemoryRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}
