import { THEMES, type Density, type ThemeId } from '../shared/api.js';

export const TOKEN_NAMES = [
  'bg',
  'side',
  'bar',
  'surface',
  'sub',
  'line',
  'line2',
  'ink',
  'ink2',
  'muted',
  'accent',
  'onAccent',
  'accentSoft',
  'accentSoftInk',
  'ok',
  'onOk',
  'okSoft',
  'warn',
  'onWarn',
  'warnSoft',
  'bad',
  'badSoft',
  'track',
] as const;
export type TokenName = (typeof TOKEN_NAMES)[number];
export type ThemeTokens = Readonly<Record<TokenName, string>>;

/** Values in `TOKEN_NAMES` order, exactly as in the owner-approved mockup. */
const PALETTES: Readonly<Record<ThemeId, string>> = {
  light:
    'F4F3EF ECEAE4 E6E3DC FFFFFF F0EEE9 DEDBD3 CFCBC1 1C1D1F 3B3D41 5C5E63 2450B2 FFFFFF E6ECF8 183B86 1E6B45 FFFFFF E3F1E8 9A4A0A FFFFFF FBEEDF A3261D F9E4E2 ECEAE4',
  dark: '17181B 1E2024 121316 22252A 2B2E34 33363D 454952 ECEDEF C9CCD2 A0A4AD 86A9FF 0E1630 22314F C3D3FF 74D29B 0C2416 1C3326 F2AE66 2A1704 3A2A18 F2948A 3B1E1C 33363D',
  sand: 'F5EFE4 EDE4D3 E5DAC5 FFFDF8 F1E9DA E0D4BE CDBF9F 2A2118 4A3D2E 6B5D4B 9C4A1A FFFFFF F5E2D3 6E2F0C 2F6B3A FFFFFF E2EFDF 8A5300 FFFFFF F8EACB A3261D F7E0DB E8DECB',
  midnight:
    '0F1626 131C30 0B1120 18233A 1F2B45 2A3753 3A4A6B E8EDF7 C3CCDD 97A3BA 5ED0C6 04211E 143A3B A6EEE7 7BD88F 082012 183223 F5B85C 2B1A02 3B2C14 FF8F85 3C1D20 2A3753',
  forest:
    'F1F4EF E5EBE1 DCE4D6 FFFFFF EBF0E7 D5DFCE BFCDB5 18211A 344236 56645A 2D6A4F FFFFFF DDEDE3 1B4734 2D6A4F FFFFFF DDEDE3 8C4A0B FFFFFF F7E8D6 A3261D F7E1DE DCE4D6',
  contrast:
    'FFFFFF FFFFFF FFFFFF FFFFFF EDEDED 000000 000000 000000 000000 262626 0033CC FFFFFF DDE5FF 001A66 00662E FFFFFF DDF5E6 8A3B00 FFFFFF FFE9D6 B00000 FFE0E0 D0D0D0',
};

function parse(palette: string): ThemeTokens {
  const values = palette.split(' ');
  return Object.fromEntries(
    TOKEN_NAMES.map((name, i) => [name, `#${values[i] ?? '000000'}`]),
  ) as ThemeTokens;
}

export const THEME_TOKENS: Readonly<Record<ThemeId, ThemeTokens>> = Object.fromEntries(
  THEMES.map((id) => [id, parse(PALETTES[id])]),
) as Record<ThemeId, ThemeTokens>;

export const THEME_LABELS: Readonly<Record<ThemeId, string>> = {
  light: 'Light',
  dark: 'Dark',
  sand: 'Sand',
  midnight: 'Midnight',
  forest: 'Forest',
  contrast: 'High contrast',
};

const cssName = (name: TokenName): string =>
  `--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

/** One `:root[data-theme=…]` rule per theme (custom properties only). */
export function themeCss(): string {
  return THEMES.map((id) => {
    const body = TOKEN_NAMES.map((n) => `${cssName(n)}:${THEME_TOKENS[id][n]};`).join('');
    return `:root[data-theme="${id}"]{${body}}`;
  }).join('\n');
}

export function applyTheme(theme: ThemeId): void {
  document.documentElement.setAttribute('data-theme', theme);
}

export function applyDensity(density: Density): void {
  document.documentElement.setAttribute('data-density', density);
}

/** Injects the theme rules; called once before the first render. */
export function installThemes(): void {
  const style = document.createElement('style');
  style.setAttribute('data-nexar-themes', '');
  style.textContent = themeCss();
  document.head.appendChild(style);
}
