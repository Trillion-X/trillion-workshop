// packages/screen-look/read-data/read-editable-screen-look-themes.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Decode screen-look-owned editable theme records from package-bound data.
// Editable themes are generic visual-token records; product-specific membership,
// onboarding, or app concepts stay outside this package.
//
// =============================================================================

import { clampToBounds, degradeColour, isSafeText } from './colour-ladder.ts';

export const DEFAULT_SCREEN_LOOK = 'midnight';
export const DEFAULT_EDITABLE_SCREEN_LOOK_THEME_ID = DEFAULT_SCREEN_LOOK;

export type EditableScreenLookTokenKind = 'color' | 'number' | 'text';

export interface EditableScreenLookToken {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly kind: EditableScreenLookTokenKind;
  readonly value: string | number;
  readonly css_variable?: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}

export interface EditableScreenLookSection {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly token_keys: readonly string[];
}

export interface EditableScreenLookTheme {
  readonly kind: 'screen-look-editable-theme';
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly author: string;
  readonly is_public: boolean;
  readonly is_favorite: boolean;
  readonly order?: number;
  readonly tokens: readonly EditableScreenLookToken[];
  readonly sections: readonly EditableScreenLookSection[];
}

const DEFAULT_TOKENS: readonly EditableScreenLookToken[] = Object.freeze([
  {
    key: 'backgroundColor',
    label: 'Background',
    description: 'Primary page and panel backdrop.',
    kind: 'color',
    value: '#0a0a0a',
    css_variable: '--bg-primary',
  },
  {
    key: 'foregroundColor',
    label: 'Text',
    description: 'Primary readable foreground color.',
    kind: 'color',
    value: '#f8fafc',
    css_variable: '--text-primary',
  },
  {
    key: 'primaryColor',
    label: 'Primary Accent',
    description: 'Main interactive accent color.',
    kind: 'color',
    value: '#ffffff',
    css_variable: '--accent-primary',
  },
  {
    key: 'surfaceColor',
    label: 'Surface',
    description: 'Card and nested-surface color.',
    kind: 'color',
    value: '#111111',
    css_variable: '--bg-surface',
  },
  {
    key: 'defaultBorderRadius',
    label: 'Radius',
    description: 'Default component corner radius in pixels.',
    kind: 'number',
    value: 16,
    css_variable: '--radius-default',
    min: 0,
    max: 32,
    step: 1,
  },
  {
    key: 'density',
    label: 'Density',
    description: 'How much room every pad, gap, control and icon takes: compact, standard or comfortable.',
    kind: 'text',
    value: 'standard',
  },
  {
    key: 'defaultPrimaryFontFamily',
    label: 'Primary Font',
    description: 'Primary UI font family.',
    kind: 'text',
    value: 'Instrument Sans',
    css_variable: '--font-primary',
  },
  {
    key: 'displayFontFamily',
    label: 'Display Font',
    description: 'Editorial display and hero font family.',
    kind: 'text',
    value: 'Instrument Sans',
    css_variable: '--font-display',
  },
  {
    key: 'monoFontFamily',
    label: 'Code font',
    description: 'Code, file paths and other fixed-width text.',
    kind: 'text',
    value: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    css_variable: '--font-mono',
  },
  {
    key: 'fontSizeDisplay',
    label: 'Display text',
    description: 'Largest editorial and hero text size in pixels.',
    kind: 'number',
    value: 48,
    css_variable: '--font-size-display',
    min: 32,
    max: 72,
    step: 1,
  },
  {
    key: 'fontSizeHeading2xl',
    label: 'Section title',
    description: 'Largest in-product section title size in pixels.',
    kind: 'number',
    value: 30,
    css_variable: '--font-size-heading-2xl',
    min: 24,
    max: 48,
    step: 1,
  },
  {
    key: 'fontSizeHeadingXl',
    label: 'Page title',
    description: 'Primary page title size in pixels.',
    kind: 'number',
    value: 24,
    css_variable: '--font-size-heading-xl',
    min: 20,
    max: 36,
    step: 1,
  },
  {
    key: 'fontSizeHeadingLg',
    label: 'Panel title',
    description: 'Panel and major card title size in pixels.',
    kind: 'number',
    value: 18,
    css_variable: '--font-size-heading-lg',
    min: 16,
    max: 28,
    step: 1,
  },
  {
    key: 'fontSizeHeading',
    label: 'Item heading',
    description: 'Readable item, lane, and card heading size in pixels.',
    kind: 'number',
    value: 14,
    css_variable: '--font-size-heading',
    min: 13,
    max: 22,
    step: 1,
  },
  {
    key: 'fontSizeHeadingXs',
    label: 'Compact heading',
    description: 'Smallest readable heading size in pixels.',
    kind: 'number',
    value: 12,
    css_variable: '--font-size-heading-xs',
    min: 12,
    max: 18,
    step: 1,
  },
  {
    key: 'fontSizeBodyLg',
    label: 'Large body',
    description: 'Prominent prose and lead text size in pixels.',
    kind: 'number',
    value: 18,
    css_variable: '--font-size-body-lg',
    min: 16,
    max: 26,
    step: 1,
  },
  {
    key: 'fontSizeBody',
    label: 'Body',
    description: 'Default readable interface and prose size in pixels.',
    kind: 'number',
    value: 14,
    css_variable: '--font-size-body',
    min: 13,
    max: 22,
    step: 1,
  },
  {
    key: 'fontSizeBodyXs',
    label: 'Compact body',
    description: 'Compact readable interface text size in pixels.',
    kind: 'number',
    value: 12,
    css_variable: '--font-size-body-xs',
    min: 12,
    max: 18,
    step: 1,
  },
  {
    key: 'fontSizeLabel',
    label: 'Label',
    description: 'Control, property, and supporting label size in pixels.',
    kind: 'number',
    value: 12,
    css_variable: '--font-size-label',
    min: 12,
    max: 18,
    step: 1,
  },
  {
    key: 'fontSizeCaption',
    label: 'Caption',
    description: 'Readable supporting copy, counts, and empty-state size in pixels.',
    kind: 'number',
    value: 12,
    css_variable: '--font-size-caption',
    min: 12,
    max: 18,
    step: 1,
  },
  {
    key: 'fontSizeMicro',
    label: 'Annotation',
    description: 'Nonessential glyph, avatar-initial, and visualization annotation size in pixels.',
    kind: 'number',
    value: 10,
    css_variable: '--font-size-micro',
    min: 10,
    max: 16,
    step: 1,
  },
]);

const DEFAULT_SECTIONS: readonly EditableScreenLookSection[] = Object.freeze([
  {
    id: 'colors',
    title: 'Colors',
    description: 'Base, foreground, accent, and surface colors.',
    token_keys: ['backgroundColor', 'foregroundColor', 'primaryColor', 'surfaceColor'],
  },
  {
    id: 'shape',
    title: 'Shape',
    description: 'Reusable spacing, radius, border, and shadow decisions.',
    token_keys: ['defaultBorderRadius', 'density'],
  },
  {
    id: 'typography',
    title: 'Typography',
    description: 'Font and semantic type-role sizes shared by every renderer adapter.',
    token_keys: [
      'defaultPrimaryFontFamily',
      'displayFontFamily',
      'monoFontFamily',
      'fontSizeDisplay',
      'fontSizeHeading2xl',
      'fontSizeHeadingXl',
      'fontSizeHeadingLg',
      'fontSizeHeading',
      'fontSizeHeadingXs',
      'fontSizeBodyLg',
      'fontSizeBody',
      'fontSizeBodyXs',
      'fontSizeLabel',
      'fontSizeCaption',
      'fontSizeMicro',
    ],
  },
]);

export const DEFAULT_EDITABLE_SCREEN_LOOK_THEME: EditableScreenLookTheme = Object.freeze({
  kind: 'screen-look-editable-theme',
  id: DEFAULT_EDITABLE_SCREEN_LOOK_THEME_ID,
  name: 'Midnight',
  description: 'Default screen-look theme record owned by the screen-look package.',
  author: 'screen-look',
  is_public: true,
  is_favorite: false,
  order: 0,
  tokens: DEFAULT_TOKENS,
  sections: DEFAULT_SECTIONS,
});

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asTokenKind(value: unknown): EditableScreenLookTokenKind | null {
  return value === 'color' || value === 'number' || value === 'text' ? value : null;
}

function parseToken(value: unknown): EditableScreenLookToken | null {
  if (!isObject(value)) return null;
  const key = asNonEmptyString(value.key);
  const label = asNonEmptyString(value.label);
  const kind = asTokenKind(value.kind);
  if (!key || !label || !kind) return null;

  const tokenValue = kind === 'number'
    ? asFiniteNumber(value.value)
    : asNonEmptyString(value.value);
  if (tokenValue === null) return null;

  const min = asFiniteNumber(value.min) ?? undefined;
  const max = asFiniteNumber(value.max) ?? undefined;
  // A value from outside that cannot be drawn degrades down the ladder (colour-ladder.json) instead of failing the look.
  const fallback = DEFAULT_TOKENS.find(token => token.key === key && token.kind === kind)?.value;
  const drawn = kind === 'number' ? clampToBounds(tokenValue as number, min, max)
    : kind === 'color' ? degradeColour(tokenValue, fallback).value
      : isSafeText(tokenValue) ? tokenValue : typeof fallback === 'string' ? fallback : null;
  if (drawn === null) return null;

  return {
    key,
    label,
    description: asNonEmptyString(value.description) ?? '',
    kind,
    value: drawn,
    css_variable: asNonEmptyString(value.css_variable) ?? undefined,
    min,
    max,
    step: asFiniteNumber(value.step) ?? undefined,
  };
}

function parseSection(value: unknown): EditableScreenLookSection | null {
  if (!isObject(value)) return null;
  const id = asNonEmptyString(value.id);
  const title = asNonEmptyString(value.title);
  if (!id || !title) return null;

  const tokenKeys = Array.isArray(value.token_keys)
    ? value.token_keys.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];

  return {
    id,
    title,
    description: asNonEmptyString(value.description) ?? '',
    token_keys: tokenKeys,
  };
}

function readPayload(row: unknown): unknown {
  if (!isObject(row)) return row;
  return 'payload' in row ? row.payload : row;
}

function completeTokens(tokens: readonly EditableScreenLookToken[]): readonly EditableScreenLookToken[] {
  const authoredByKey = new Map(tokens.map((token) => [token.key, token] as const));
  // Existing Screen Looks already own their palette through open tokens whose
  // keys mirror CSS variables (`black-pure`, `surface-base`, and so on). Filling
  // those themes with Midnight's compact base keys would make the resolver pick
  // the injected defaults before the theme's authored palette. Only the newly
  // introduced visual-role family is schema completion; all other appearance
  // remains exactly the theme's authored data.
  const completionTokens = DEFAULT_TOKENS.filter((token) => token.key.startsWith('fontSize'));
  return [
    ...tokens,
    ...completionTokens.filter((token) => !authoredByKey.has(token.key)),
  ];
}

function completeSections(sections: readonly EditableScreenLookSection[]): readonly EditableScreenLookSection[] {
  const authoredById = new Map(sections.map((section) => [section.id, section] as const));
  const typography = DEFAULT_SECTIONS.find((section) => section.id === 'typography');
  if (!typography) return sections;
  const authored = authoredById.get(typography.id);
  const completedTypography = authored
    ? {
      ...authored,
      token_keys: [...new Set([...authored.token_keys, ...typography.token_keys])],
    }
    : typography;
  return [
    ...sections.map((section) => (
      section.id === typography.id ? completedTypography : section
    )),
    ...(authored ? [] : [completedTypography]),
  ];
}

/** One look record (a looks DATA row `{ address, payload }`, or its payload alone) as a look, or null when it is not one:
 *  the one decoder every list, file and app reads looks through. */
export function readScreenLookRecord(value: unknown): EditableScreenLookTheme | null {
  const payload = readPayload(value);
  if (!isObject(payload) || payload.kind !== 'screen-look-editable-theme') return null;

  const id = asNonEmptyString(payload.id);
  const name = asNonEmptyString(payload.name);
  if (!id || !name) return null;

  const tokens = Array.isArray(payload.tokens)
    ? payload.tokens.map(parseToken).filter((token): token is EditableScreenLookToken => !!token)
    : [];
  const sections = Array.isArray(payload.sections)
    ? payload.sections.map(parseSection).filter((section): section is EditableScreenLookSection => !!section)
    : [];

  return {
    kind: 'screen-look-editable-theme',
    id,
    name,
    description: asNonEmptyString(payload.description) ?? '',
    author: asNonEmptyString(payload.author) ?? 'screen-look',
    is_public: asBoolean(payload.is_public, false),
    is_favorite: asBoolean(payload.is_favorite, false),
    order: asFiniteNumber(payload.order) ?? undefined,
    tokens: completeTokens(tokens),
    sections: completeSections(sections),
  };
}

export function readEditableScreenLookThemes(raw: unknown): EditableScreenLookTheme[] {
  const rows = Array.isArray(raw) ? raw : [];
  const themes = rows
    .map(readScreenLookRecord)
    .filter((theme): theme is EditableScreenLookTheme => !!theme)
    .sort((a, b) => (
      (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)
      || a.name.localeCompare(b.name)
      || a.id.localeCompare(b.id)
    ));

  return themes.length > 0 ? themes : [DEFAULT_EDITABLE_SCREEN_LOOK_THEME];
}

export function readEditableScreenLookTheme(
  raw: unknown,
  themeId = DEFAULT_EDITABLE_SCREEN_LOOK_THEME_ID,
): EditableScreenLookTheme {
  return readEditableScreenLookThemes(raw).find((theme) => theme.id === themeId)
    ?? DEFAULT_EDITABLE_SCREEN_LOOK_THEME;
}
