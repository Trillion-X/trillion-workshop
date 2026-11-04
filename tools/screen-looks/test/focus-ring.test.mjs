// tools/screen-looks/read-data/resolve-screen-look-palette.js (F-0287): a focus ring that reads on any fill, from a made-up look:
// a page-coloured inner gap, a ring in the look's ink and a soft accent glow, with a danger twin built the same way.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveScreenLookPalette } from '../read-data/resolve-screen-look-palette.js';

const look = {
  id: 'harbour',
  tokens: [
    { key: 'black-pure', kind: 'color', value: '#eef2f0', css_variable: '--black-pure' },
    { key: 'text-primary', kind: 'color', value: '#1d2b2a', css_variable: '--text-primary' },
    { key: 'accent-primary', kind: 'color', value: '#0f7a6b', css_variable: '--accent-primary' },
  ],
};

test('the focus ring is a page-coloured gap, then the ink ring, then a soft glow; the danger twin has the same shape', () => {
  const palette = resolveScreenLookPalette(look);
  const ring = palette['--focus-ring'];
  const gap = palette['--focus-ring-offset'];
  const outer = Number.parseFloat(gap) + Number.parseFloat(palette['--focus-ring-width']);
  const layers = ring.split(/,\s*(?![^(]*\))/);
  assert.equal(layers.length, 3, ring);
  assert.match(layers[0], new RegExp(`^0 0 0 ${gap} `));
  assert.ok(layers[1].startsWith(`0 0 0 ${outer}px `) && layers[1].endsWith(palette['--focus-ring-color']), layers[1]);
  assert.ok(layers[2].endsWith(palette['--focus-ring-glow']), layers[2]);
  assert.equal(palette['--border-focus'], palette['--focus-ring-color']);
  const danger = palette['--focus-ring-danger'].split(/,\s*(?![^(]*\))/);
  assert.equal(danger.length, 3);
  assert.equal(danger[0], layers[0], 'the same page-coloured gap');
  assert.ok(danger[1].endsWith(palette['--focus-ring-danger-color']));
  assert.notEqual(palette['--focus-ring-danger-color'], palette['--focus-ring-color']);
});
