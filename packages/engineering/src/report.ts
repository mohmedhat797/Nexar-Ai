/** The report returned to a caller is at most this many bytes of UTF-8 (ADR-025 amendment). */
export const MAX_REPORT_BYTES = 64 * 1024;
/** An outcome lists at most this many lane executions. */
export const MAX_OUTCOME_LANES = 16;

/**
 * Cuts `text` to at most `maxBytes` of UTF-8 on a character boundary, so a surrogate pair or a
 * multi-byte character is never split. Returns the text unchanged when it already fits.
 */
export function boundReport(
  text: string,
  maxBytes: number = MAX_REPORT_BYTES,
): { readonly text: string; readonly truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  // A continuation byte (10xxxxxx) at the cut means the cut is inside a character: back up to its start.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true };
}
