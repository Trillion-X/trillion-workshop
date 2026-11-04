// Finding pictures by colour and likeness (src/colour-search.mjs, thresholds in src/colour-search.json).
import assert from 'node:assert/strict';
import test from 'node:test';
import { deltaE, labOf, matchColour, matchNamedColour, paletteOf, rgbOf, similarTo } from '../src/colour-search.mjs';
import facts from '../src/workspace/file-facts.json' with { type: 'json' };

const rows = [
  { id: 'sunset', palette: ['#ff5a1f', '#2b1b3d'], embedding: [1, 0, 0] },
  { id: 'brick', palette: ['#e8501c', '#444444'], embedding: [0.6, 1, 0] },
  { id: 'sea', palette: ['#0a4fa8', '#e6f0ff'], embedding: [0, 0, 1] },
  { id: 'bare', palette: ['#0b50a6'] },
];

test('colour is compared in LAB: a typed hex matches near colours only', () => {
  assert.ok(Math.abs(deltaE(labOf([255, 255, 255]), labOf([0, 0, 0])) - 100) < 0.1);
  assert.deepEqual(matchColour(rows, '#ff5a1f'), ['sunset', 'brick']);
  assert.deepEqual(matchColour(rows, '#0a4fa8'), ['sea', 'bare']);
  assert.deepEqual(matchColour(rows, '#00ff00'), []);
});

test('a named colour is stricter and looks only at the leading colours', () => {
  assert.deepEqual(matchNamedColour(rows, '#e6f0ff'), ['sea']);
  const wide = [{ id: 'x', palette: ['#000000', '#111111', '#222222', '#ff0000'] }];
  assert.deepEqual(matchColour(wide, '#ff0000'), ['x']);
  assert.deepEqual(matchNamedColour(wide, '#ff0000'), [], 'red is the fourth colour, past the top 3');
});

test('a palette keeps leading colours then diverse histogram colours, never two near-identical', () => {
  const pixels = new Uint8ClampedArray(4 * 100);
  for (let i = 0; i < 100; i += 1) pixels.set(i < 60 ? [200, 30, 30, 255] : i < 90 ? [205, 32, 30, 255] : [20, 20, 200, 255], i * 4);
  const palette = paletteOf(pixels, ['#00aa00']);
  assert.equal(palette[0], '#00aa00');
  assert.equal(palette.length, 3, 'the two reds share one slot');
  assert.ok(palette.every(hex => rgbOf(hex)));
});

test('more like this: embedding first, palette distance when there is no embedding or nothing passes the floor', () => {
  assert.deepEqual(similarTo(rows, 'sunset'), { ids: ['brick'], by: 'embedding' });
  assert.deepEqual(similarTo(rows, 'bare'), { ids: ['sea'], by: 'palette' });
  assert.deepEqual(similarTo(rows, 'sea'), { ids: ['bare'], by: 'palette' }, 'nothing over the floor falls back to palette');
  assert.deepEqual(similarTo(rows, 'missing').ids, []);
});

test('the palette is a file fact a view can show', () => {
  assert.ok(facts.fields.some(field => field.id === 'palette'));
});
