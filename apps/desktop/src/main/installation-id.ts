import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NexarError } from '@nexar/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BYTES = 1024;

const damaged = (): NexarError =>
  new NexarError('CONFIGURATION_ERROR', 'The installation identity is unavailable');

async function read(path: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw damaged();
  }
  try {
    const value = text.length <= MAX_BYTES ? (JSON.parse(text) as { id?: unknown }) : undefined;
    if (typeof value?.id === 'string' && UUID.test(value.id)) return value.id;
  } catch {
    /* Falls through to the fixed error: the content is never echoed. */
  }
  throw damaged();
}

/**
 * A random id for this installation, generated once and kept in Desktop's private state directory.
 * It is not a hardware id and not a secret; OpenAI uses it to tell installations of one app apart.
 * A damaged file is an error, never silently replaced (a new id would look like a new installation).
 */
export async function installationId(
  userData: string,
  newId: () => string = randomUUID,
): Promise<string> {
  const path = join(userData, 'installation.json');
  const existing = await read(path);
  if (existing !== undefined) return existing;
  const id = newId().toLowerCase();
  if (!UUID.test(id)) throw damaged();
  try {
    await writeFile(path, `${JSON.stringify({ id })}\n`, { mode: 0o600, flag: 'wx' });
    return id;
  } catch (error) {
    // Lost a creation race: use whichever id won.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw damaged();
    const winner = await read(path);
    if (winner === undefined) throw damaged();
    return winner;
  }
}
