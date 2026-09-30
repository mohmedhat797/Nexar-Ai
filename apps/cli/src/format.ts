import type { Measured } from '@nexar/contracts';

/** `12`, `~0.0031 (estimated)`, or `n/a`. */
export function formatMeasured(m: Measured<number>): string {
  switch (m.status) {
    case 'measured':
      return String(m.value);
    case 'estimated':
      return `~${String(m.value)} (estimated)`;
    case 'unavailable':
      return 'n/a';
  }
}

/** Left-aligned plain-text table; the last column is not padded. */
export function renderTable(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: readonly string[]): string =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  return [line(header), ...rows.map(line)].join('\n');
}
