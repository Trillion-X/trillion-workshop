// parts/screen-look/read-data/browser-chrome-colour.mjs
//
// The colour a phone's status bar and the browser's own bar take for a page (`<meta name="theme-color">`): the worn
// look's ground, `--bg-primary`, else `--surface-base`. The look decides it, not the device's light or dark setting,
// because the page wears the look whatever that setting is. Read by the server page shell
// (ui/show/server-rendered-page/page-sections-html.mjs) for the first bytes and by ApplyCurrentScreenLook.tsx whenever
// the worn look changes, so both write the same colour.

/** A plain CSS colour a browser can paint its own chrome with: hex, a colour function or a named colour. A variable,
 *  a gradient, a value with a nested function or anything longer is not one. */
export const PLAIN_PAGE_COLOUR = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([0-9a-z.,%/\s+-]{1,120}\)|[a-z]{3,30})$/i;

/** The look's ground as a plain colour from a palette (CSS variable name to value), or null when it has none. */
export function browserChromeColour(palette) {
  const values = palette && typeof palette === 'object' ? palette : {};
  for (const value of [values['--bg-primary'], values['--surface-base']]) {
    const colour = typeof value === 'string' ? value.trim() : '';
    if (PLAIN_PAGE_COLOUR.test(colour)) return colour;
  }
  return null;
}
