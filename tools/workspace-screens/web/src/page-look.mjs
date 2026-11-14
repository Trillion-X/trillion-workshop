// src/page-look.mjs
// The look every server-rendered Trillion page wears: the same screen-look theme a new account's workspace starts with
// (src/workspace/looks.json `start_with`), resolved to concrete CSS variables by the one screen-look resolver, plus the
// faces that theme names, served beside the workspace stylesheet (scripts/build-workspace.mjs copies fonts.css and
// fonts/ to /workspace/). The shared page shell (parts/ui/show/server-rendered-page) writes it; nothing here names a
// colour or a font, so changing the workspace's starting look changes every page with it.
import { resolveScreenLookPalette } from 'trillion-workshop/tools/screen-look/read-data/resolve-screen-look-palette.js';
import { readEditableScreenLookThemes } from 'trillion-workshop/tools/screen-look/read-data/read-editable-screen-look-themes.ts';
import looks from './workspace/looks.json' with { type: 'json' };

// The relative lightness of a #rrggbb ground (WCAG), 1 for anything else.
const lightness = value => {
  const match = /^#([0-9a-f]{6})$/i.exec(String(value ?? ''));
  if (!match) return 1;
  const rgb = [0, 2, 4].map(at => parseInt(match[1].slice(at, at + 2), 16) / 255);
  const linear = rgb.map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
  return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
};
/** 'dark' or 'light': the scheme a palette's own ground is, so the page's built-in controls and marks match it. */
export const lookScheme = palette => lightness(palette?.['--bg-primary'] ?? palette?.['--surface-base']) < .18 ? 'dark' : 'light';

const pageLook = theme => {
  const palette = Object.freeze(resolveScreenLookPalette(theme));
  return Object.freeze({ palette, scheme: lookScheme(palette), stylesheets: Object.freeze(['/workspace/fonts.css']) });
};

/** `{ palette, scheme, stylesheets }` for the page shell's `look`, from one of the themes this app offers by its id. */
export function lookFor(themeId) {
  const theme = looks.themes.find(row => row.payload?.id === themeId)?.payload;
  if (!theme) throw new Error(`src/workspace/looks.json does not offer the look "${themeId}".`);
  return pageLook(theme);
}

/** The look every page wears unless it names another: the one a new account's workspace starts with. */
export const PAGE_LOOK = lookFor(looks.start_with);

/** The look a page that belongs to one person wears: that person's worn look, from what their store answers for it
 *  (src/looks.mjs `page`: { worn, plan, looks }), resolved by the same resolver, with the faces every page carries.
 *  Nothing answered, or a look that cannot be read, is PAGE_LOOK. A shared link, an AI app's view of a screen and an
 *  email all wear the look of the person they come from through this, so none of them keeps a look of its own. */
export function wornLook(worn) {
  try {
    const theme = readEditableScreenLookThemes(worn?.looks ?? []).find(row => row.id === worn?.worn);
    if (theme) return pageLook(theme);
  } catch { /* an unreadable look is the look every page starts with */ }
  return PAGE_LOOK;
}
