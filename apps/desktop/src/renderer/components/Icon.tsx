import type { ReactElement } from 'react';

const PATHS = {
  chat: 'M4 5h16v11H9l-5 4z',
  workflow: 'M5 5h5v5H5zM14 14h5v5h-5zM10 7.5h4a2 2 0 0 1 2 2V14',
  approval: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z M9 12l2 2 4-4',
  resources: 'M4 6h16M4 12h16M4 18h16M8 4v4M15 10v4M10 16v4',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12l2-1-2-4-2 .5-1.5-1L15 4h-4l-.5 2.5-1.5 1L7 7 5 11l2 1v1l-2 1 2 4 2-.5 1.5 1L11 20h4l.5-2.5 1.5-1 2 .5 2-4-2-1z',
  folder: 'M3 6h6l2 2h10v10H3z',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  plus: 'M12 5v14M5 12h14',
  panel: 'M3 5h18v14H3zM15 5v14',
  send: 'M4 12l16-8-6 16-3-7z',
  chevron: 'M9 6l6 6-6 6',
  open: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  close: 'M6 6l12 12M18 6L6 18',
  code: 'M9 7l-5 5 5 5M15 7l5 5-5 5',
} as const;

export type IconName = keyof typeof PATHS;

/** Inline stroke icon; decorative unless the parent button carries an `aria-label`. */
export function Icon({ name, size = 18 }: { name: IconName; size?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
