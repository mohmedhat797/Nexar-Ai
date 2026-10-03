import { createHash } from 'node:crypto';
import { NexarError } from '@nexar/contracts';
import type { ArtifactRef } from '@nexar/contracts';
import type { ContextManifest, OperatingSession, Turn } from '@nexar/sessions';

/*
 * `context@1` (ADR-024 §10): a deterministic, bounded context built only from the session's own
 * turns. Prior owner text and prior model output are rendered inside `<untrusted-input>` (ADR-017)
 * and never reach a trusted system prompt. Artifacts appear by safe display name only, never by URI.
 * The manifest explains inclusion and carries counts and a hash, never content.
 */

export const CONTEXT_POLICY = 'context@1';
export const MAX_CONTEXT_TURNS = 6;
export const MAX_CONTEXT_CHARS = 24_000;
export const MAX_CONTEXT_SIDE_CHARS = 2_000;
const MAX_ARTIFACT_NAME_CHARS = 200;

export interface BuildContextInput {
  readonly session: OperatingSession;
  /** The turn being executed; only turns before it are eligible. */
  readonly turnId: string;
  /** Returns a safe display name for an artifact, or undefined to drop it. */
  readonly describeArtifact?: ((ref: ArtifactRef) => string | undefined) | undefined;
}

export interface BuiltContext {
  readonly prompt: string;
  readonly manifest: ContextManifest;
}

/** Same rule as `neutralize` in `@nexar/workflows`: an embedded value cannot close the wrapper. */
function neutralize(value: string): string {
  return value.replace(/<(\s*)\/(\s*)untrusted-input/gi, '<$1/$2untrusted_input');
}

function wrap(name: string, lines: readonly string[]): string[] {
  return [`<untrusted-input name="${name}">`, ...lines, '</untrusted-input>'];
}

function truncate(text: string, max: number): { readonly text: string; readonly cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  let end = max;
  const last = text.charCodeAt(end - 1);
  // Do not split a surrogate pair.
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), cut: true };
}

function artifactNames(
  turn: Turn,
  describe: ((ref: ArtifactRef) => string | undefined) | undefined,
): string[] {
  if (describe === undefined) return [];
  const names: string[] = [];
  for (const ref of turn.artifacts) {
    const described = describe(ref);
    if (described === undefined) continue;
    const name = truncate(
      described.replace(/[\r\n\t]+/g, ' ').trim(),
      MAX_ARTIFACT_NAME_CHARS,
    ).text;
    if (name.length > 0) names.push(name);
  }
  return names;
}

interface Included {
  readonly turn: Turn;
  readonly owner: string;
  readonly nexar: string;
  readonly cut: boolean;
  readonly artifacts: readonly string[];
}

export function buildContext(input: BuildContextInput): BuiltContext {
  const { session, turnId } = input;
  const position = session.turns.findIndex((t) => t.id === turnId);
  const current = session.turns[position];
  if (current === undefined) {
    throw new NexarError('VALIDATION_ERROR', 'Unknown turn', {
      details: { reason: 'unknown-turn' },
    });
  }

  const eligible = session.turns.slice(0, position).filter((t) => t.state === 'succeeded');
  const newestFirst: Included[] = [];
  let budget = 0;
  for (const turn of [...eligible].reverse()) {
    if (newestFirst.length >= MAX_CONTEXT_TURNS) break;
    const owner = truncate(turn.text, MAX_CONTEXT_SIDE_CHARS);
    const reply = truncate(turn.outcome?.text ?? '', MAX_CONTEXT_SIDE_CHARS);
    const size = owner.text.length + reply.text.length;
    if (budget + size > MAX_CONTEXT_CHARS) break;
    budget += size;
    newestFirst.push({
      turn,
      owner: owner.text,
      nexar: reply.text,
      cut: owner.cut || reply.cut,
      artifacts: artifactNames(turn, input.describeArtifact),
    });
  }
  const included = newestFirst.reverse();

  const lane = current.lane?.effectiveLane ?? 'direct';
  const lines: string[] = [
    `Session policy: mode=${session.mode}; lane=${lane}; project=${neutralize(session.projectId)}`,
  ];
  if (included.length > 0) {
    const conversation: string[] = [];
    for (const item of included) {
      const label = `[turn ${String(item.turn.index + 1)}]`;
      conversation.push(`${label} Owner: ${neutralize(item.owner)}`);
      conversation.push(
        `${label} Nexar: ${neutralize(item.nexar.length > 0 ? item.nexar : '(no text)')}`,
      );
      if (item.artifacts.length > 0) {
        conversation.push(`${label} Artifacts: ${neutralize(item.artifacts.join(', '))}`);
      }
    }
    lines.push(...wrap('conversation', conversation));
  }
  lines.push('Current request:', ...wrap('request', [neutralize(current.text)]));
  const prompt = lines.join('\n');

  const artifactIds: string[] = [];
  for (const item of included) {
    for (const name of item.artifacts) if (!artifactIds.includes(name)) artifactIds.push(name);
  }
  const manifest: ContextManifest = {
    policy: CONTEXT_POLICY,
    turnIds: included.map((i) => i.turn.id),
    omittedTurns: eligible.length - included.length,
    truncatedTurnIds: included.filter((i) => i.cut).map((i) => i.turn.id),
    chars: prompt.length,
    artifactIds,
    hash: createHash('sha256').update(prompt).digest('hex'),
  };
  return { prompt, manifest };
}
