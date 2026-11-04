// packages/screen-look/show/ApplyCurrentScreenLook.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Browser DOM realization for the selected screen look. Other devices can
// realize the same Society data through their own native mechanisms.
//
// =============================================================================

import {
  DEFAULT_EDITABLE_SCREEN_LOOK_THEME,
  type EditableScreenLookTheme,
} from '../read-data/read-editable-screen-look-themes';
import {
  resolveScreenLookPalette,
  screenLookFontFamily as resolveScreenLookFontFamily,
} from '../read-data/resolve-screen-look-palette';
import { LOOK_OVER_TIME } from '../read-data/look-over-time';
import { screenLookScheme as schemeOfGround } from '../read-data/look-scheme.ts';
import { paintBrowserChrome } from './paint-browser-chrome';

type CssVariableMap = Record<string, string>;

export function screenLookFontFamily(value: string): string {
  return resolveScreenLookFontFamily(value);
}

export function resolveDerivedScreenLookCssVariables(
  theme: EditableScreenLookTheme,
): CssVariableMap {
  return resolveScreenLookPalette(theme) as CssVariableMap;
}

const DERIVED_SCREEN_LOOK_CSS_VARIABLES = Object.freeze(
  Object.keys(resolveDerivedScreenLookCssVariables(DEFAULT_EDITABLE_SCREEN_LOOK_THEME)),
);

const appliedScreenLookVariables = new Set<string>();
const TYPOGRAPHY_UTILITY_STYLE_ID = 'screen-look-typography-utilities';

function clearEditableTokenOverrides(root: HTMLElement): void {
  for (const variable of new Set([...DERIVED_SCREEN_LOOK_CSS_VARIABLES, ...appliedScreenLookVariables])) {
    root.style.removeProperty(variable);
  }
  appliedScreenLookVariables.clear();
}

export function resolveScreenLookCssVariables(theme: EditableScreenLookTheme): CssVariableMap {
  return resolveDerivedScreenLookCssVariables(theme);
}

export function screenLookTypographyUtilityCss(variables: CssVariableMap): string {
  return Object.keys(variables)
    .filter((variable) => /^--font-size-[a-z0-9-]+$/u.test(variable))
    .sort()
    .map((variable) => (
      `[class~="text-[length:var(${variable})]"] { font-size: var(${variable}); }`
    ))
    .join('\n');
}

function applyScreenLookTypographyUtilities(variables: CssVariableMap): void {
  const css = screenLookTypographyUtilityCss(variables);
  let style = document.getElementById(TYPOGRAPHY_UTILITY_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = TYPOGRAPHY_UTILITY_STYLE_ID;
    document.head.append(style);
  }
  style.textContent = css;
}

/** Whether a look is light or dark, from its own ground colour (look-over-time.json keep_readable.ground): dark when white
 *  words read better on it than black ones. Null when the ground is not a plain colour. */
export const screenLookScheme = (resolvedVariables: CssVariableMap): 'light' | 'dark' | null => schemeOfGround(resolvedVariables, LOOK_OVER_TIME.keep_readable.ground);

/** Paints concrete values (CSS variable to value) on the page under the look id `screenLook`: the one way a look
 *  reaches the page, whether it is one look whole or a blend of two (read-data/look-over-time.ts). The look alone says
 *  whether the page is light or dark (data-look-scheme, which look-bridges.css turns into the page's color-scheme), so
 *  a page framed inside another app (an AI app setting data-theme or color-scheme on the frame's root for its own
 *  theme) never mixes the app's dark with the look's colours. */
export function applyScreenLookValues(screenLook: string, resolvedVariables: CssVariableMap): string {
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    root.setAttribute('data-theme', screenLook);
    root.setAttribute('data-screen-look-theme', screenLook);
    const scheme = screenLookScheme(resolvedVariables);
    if (scheme) root.setAttribute('data-look-scheme', scheme);
    else root.removeAttribute('data-look-scheme');
    clearEditableTokenOverrides(root);
    for (const [variable, value] of Object.entries(resolvedVariables)) {
      root.style.setProperty(variable, value);
      appliedScreenLookVariables.add(variable);
    }
    applyScreenLookTypographyUtilities(resolvedVariables);
    const pageBackground = resolvedVariables['--bg-primary'];
    if (pageBackground && document.body) {
      document.body.style.setProperty('background-color', pageBackground);
    }
    paintBrowserChrome(document, resolvedVariables);
  }
  return screenLook;
}

export function applyScreenLookTheme(theme: EditableScreenLookTheme): string {
  return applyScreenLookValues(theme.id, resolveScreenLookCssVariables(theme));
}

// A look shown for a moment over whatever the page would wear (the editor's draft while a look is being changed). The
// page's one painter (ScreenLookSurface) paints it while it is set and goes back to its own rule when it is cleared.
let previewLook: EditableScreenLookTheme | null = null;
const previewListeners = new Set<() => void>();
export function previewScreenLook(theme: EditableScreenLookTheme | null): void {
  previewLook = theme;
  previewListeners.forEach(listener => listener());
}
export const readPreviewScreenLook = (): EditableScreenLookTheme | null => previewLook;
export function subscribePreviewScreenLook(listener: () => void): () => void {
  previewListeners.add(listener);
  return () => { previewListeners.delete(listener); };
}

export const applyTheme = applyScreenLookTheme;
