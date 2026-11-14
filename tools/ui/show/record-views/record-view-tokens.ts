// packages/ui/show/record-views/record-view-tokens.ts
//
// Purpose
//   Design tokens for the record table and board, taken from Twenty CRM's
//   `twenty-ui` theme so these surfaces inherit a proven CRM anatomy instead of
//   being re-invented per app.
//
// Provenance
//   Values transcribed from twenty-ui/src/theme/constants: GrayScaleLight.ts,
//   ThemeCommon.ts and ThemeLight.ts. Twenty is AGPL-3.0; nothing marked
//   `@license Enterprise` is used here. These are token VALUES, not their code.
//
// Non-negotiable invariants
//   - Tokens only. No component, no app name, no field name lives in this file.
//   - Tone names are an open set fed by DATA; the map below is a starting
//     palette a caller may extend, never a closed list the renderer branches on.

export const GRAY = {
  1: 'color(display-p3 1 1 1)',
  2: 'color(display-p3 0.988 0.988 0.988)',
  3: 'color(display-p3 0.976 0.976 0.976)',
  4: 'color(display-p3 0.945 0.945 0.945)',
  5: 'color(display-p3 0.922 0.922 0.922)',
  6: 'color(display-p3 0.839 0.839 0.839)',
  7: 'color(display-p3 0.8 0.8 0.8)',
  8: 'color(display-p3 0.702 0.702 0.702)',
  9: 'color(display-p3 0.6 0.6 0.6)',
  10: 'color(display-p3 0.514 0.514 0.514)',
  11: 'color(display-p3 0.4 0.4 0.4)',
  12: 'color(display-p3 0.2 0.2 0.2)',
} as const

/** Twenty's tag palette: a readable text tone over a soft background of the
 *  same hue. A caller adds a tone by adding a row, never by editing a renderer. */
export const TONES: Record<string, { text: string; background: string }> = {
  grey: { text: GRAY[11], background: GRAY[4] },
  red: { text: 'color(display-p3 0.744 0.234 0.222)', background: 'color(display-p3 0.985 0.925 0.925)' },
  green: { text: 'color(display-p3 0.19 0.5 0.32)', background: 'color(display-p3 0.913 0.964 0.925)' },
  blue: { text: 'color(display-p3 0.256 0.354 0.755)', background: 'color(display-p3 0.933 0.948 0.992)' },
  turquoise: { text: 'color(display-p3 0.08 0.5 0.43)', background: 'color(display-p3 0.895 0.971 0.952)' },
  yellow: { text: 'color(display-p3 0.6 0.44 0)', background: 'color(display-p3 0.997 0.982 0.749)' },
}

export const SPACING_STEP = 4
export const spacing = (steps: number) => `${steps * SPACING_STEP}px`

export const TABLE = {
  cellPadding: '8px',
  cellMargin: '8px',
  checkboxColumnWidth: '32px',
  rowHeight: '32px',
  headerHeight: '32px',
  betweenSiblingsGap: '2px',
  border: GRAY[5],
  headerText: GRAY[10],
  bodyText: GRAY[12],
  hover: GRAY[3],
  selected: '#0047f112',
} as const

export const BOARD = {
  columnWidth: '280px',
  columnGap: '8px',
  cardGap: '4px',
  cardPadding: '8px',
  cardRadius: '4px',
} as const

export const TEXT = {
  lineHeightRoomy: 1.5,
  lineHeightTight: 1.1,
  iconSm: 14,
  iconMd: 16,
} as const

/** Deterministic tone for a value that carries no declared tone, so the same
 *  project or status keeps the same colour between renders and between
 *  sessions. A random or index-based choice would change on every sort. */
export function toneForValue(value: string, names = Object.keys(TONES).filter(name => name !== 'grey')): string {
  if (!value) return 'grey'
  let hash = 0
  for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  return names[hash % names.length]
}
