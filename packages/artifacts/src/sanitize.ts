export type ArtifactMediaType = 'text/markdown' | 'text/plain' | 'application/json' | 'text/csv';

export const EXTENSION_BY_MEDIA_TYPE: Readonly<Record<ArtifactMediaType, string>> = {
  'text/markdown': '.md',
  'text/plain': '.txt',
  'application/json': '.json',
  'text/csv': '.csv',
};

export const MAX_FILENAME_LENGTH = 100;

const RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

function trimEdges(value: string): string {
  return value.replace(/^[.-]+/, '').replace(/[.-]+$/, '');
}

/**
 * Turns an untrusted name (AI output, external request) into a safe single file name:
 * last path segment only, `[A-Za-z0-9._-]` only, no leading dot, no Windows reserved basename,
 * and an extension forced to match `mediaType` so a model cannot produce `.sh` or `.html`.
 */
export function sanitizeFilename(untrusted: string, mediaType: ArtifactMediaType): string {
  const extension = EXTENSION_BY_MEDIA_TYPE[mediaType];
  const segment = untrusted.split(/[\\/]/).pop() ?? '';
  let name = segment
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+/, '');

  // Whatever extension the caller supplied is replaced by the one matching the media type.
  const dot = name.lastIndexOf('.');
  if (dot > 0) name = name.slice(0, dot);
  let stem = trimEdges(name);
  if (stem === '') stem = 'artifact';
  if (RESERVED_NAMES.test(stem.split('.')[0] ?? '')) stem = `_${stem}`;

  stem = trimEdges(stem.slice(0, MAX_FILENAME_LENGTH - extension.length)) || 'artifact';
  return stem + extension;
}
