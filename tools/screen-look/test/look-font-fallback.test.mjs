// A look that names its face as a raw CSS variable (the built-in default look's --font-primary) still gets the sans fallback,
// so a face that is not loaded never falls to the browser's serif.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveScreenLookPalette, screenLookFontFamily } from 'trillion-workshop/tools/screen-look/read-data/resolve-screen-look-palette.js';

test('a raw font variable carries the sans fallback and a generic family is left alone', () => {
  const palette = resolveScreenLookPalette({ tokens: [
    { key: 'defaultPrimaryFontFamily', kind: 'text', value: 'Instrument Sans', css_variable: '--font-primary' },
    { key: 'displayFontFamily', kind: 'text', value: 'monospace', css_variable: '--font-display' },
  ] });
  assert.equal(palette['--font-primary'], screenLookFontFamily('Instrument Sans'));
  assert.match(palette['--font-primary'], /^Instrument Sans, .*sans-serif/);
  assert.equal(palette['--font-display'], 'monospace');
  console.log('readback --font-primary:', palette['--font-primary']);
});
