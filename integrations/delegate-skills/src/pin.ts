import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

/** The Delegate Skills commit the relay handling was written against. */
export const PINNED_UPSTREAM_SHA = '6826b363085dcc80875372315fe7d208c4bf733f';

/** Short form used in `resolved.runtimeVersion`. */
export const RELAY_VERSION_LABEL = `relay@${PINNED_UPSTREAM_SHA.slice(0, 7)}`;

/** A relay script is a few dozen KB of source; anything this large is not the relay. */
const MAX_RELAY_BYTES = 4 * 1024 * 1024;

export type PinCheck = 'ok' | 'missing' | 'mismatch';

/**
 * Reads the relay script and compares its sha256 to the owner's pin. The relay is code, not a
 * credential, so reading it is fine. On success the verified bytes are returned: the adapter runs a
 * private copy of exactly these bytes, so a swap of the original file after the check has no effect.
 */
export async function readPinnedRelay(
  relayPath: string,
  expectedSha256: string,
): Promise<{ readonly pin: PinCheck; readonly bytes?: Buffer }> {
  let bytes: Buffer;
  try {
    const info = await stat(relayPath);
    if (!info.isFile() || info.size > MAX_RELAY_BYTES) return { pin: 'mismatch' };
    bytes = await readFile(relayPath);
  } catch {
    return { pin: 'missing' };
  }
  if (bytes.length > MAX_RELAY_BYTES) return { pin: 'mismatch' };
  const actual = createHash('sha256').update(bytes).digest('hex');
  return actual === expectedSha256 ? { pin: 'ok', bytes } : { pin: 'mismatch' };
}

/** Pin check without keeping the bytes (probe). */
export async function checkRelayPin(relayPath: string, expectedSha256: string): Promise<PinCheck> {
  return (await readPinnedRelay(relayPath, expectedSha256)).pin;
}
