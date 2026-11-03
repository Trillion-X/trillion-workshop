// tools/screen-looks/read-data/theme-from-inputs.ts (DATA: tools/screen-looks/theme-inputs.json): a whole look from three picks
// (base, accent, contrast), derived in OKLCH and held to contrast floors.
// Moved from old trillion test/theme-from-inputs.test.ts:1-50 with its assertions unchanged. Its last two tests exercise
// screen-look-record.ts and the Worker's looks owner (src/looks.mjs), which have not moved; they stay there until those move.
import test from 'node:test';
import assert from 'node:assert/strict';
import { themeFromInputs } from '../read-data/theme-from-inputs.ts';
import { colourOf, contrast } from '../read-data/look-scheme.ts';
import rules from '../theme-inputs.json' with { type: 'json' };

const ratio = (changes: Record<string, string>, text: string, ground: string) => contrast(colourOf(changes[text])!, colourOf(changes[ground])!);

test('a dark base makes a dark look, a light base a light one', () => {
  assert.equal(themeFromInputs({ base: '#101418', accent: '#3b82f6' }).scheme, 'dark');
  assert.equal(themeFromInputs({ base: '#f6f1e7', accent: '#3b82f6' }).scheme, 'light');
});

test('every floor holds for many bases, accents and contrasts, in both schemes', () => {
  const bases = ['#000000', '#101418', '#2a2a40', '#7a7a7a', '#d8d8d8', '#f6f1e7', '#ffffff', '#fff3d6'];
  const accents = ['#ff1d1d', '#3b82f6', '#16a34a', '#fde047', '#7c3aed', '#808080', '#00ffff'];
  for (const base of bases) for (const accent of accents) for (const contrastPick of [0, 25, 50, 100]) {
    const made = themeFromInputs({ base, accent, contrast: contrastPick });
    assert.deepEqual(made.unmet, [], `${base} ${accent} ${contrastPick}`);
    assert.ok(ratio(made.changes, 'text-primary', 'black-pure') >= 4.5 - 0.02, `ink ${base} ${accent} ${contrastPick}`);
    assert.ok(ratio(made.changes, 'accent-primary', 'black-pure') >= 3 - 0.02, `action ${base} ${accent} ${contrastPick}`);
    assert.ok(ratio(made.changes, 'button-primary-text', 'button-primary-bg') >= 4.5 - 0.02, `on-action ${base} ${accent} ${contrastPick}`);
  }
});

test('contrast moves ink further from the ground', () => {
  const soft = themeFromInputs({ base: '#f6f1e7', accent: '#3b82f6', contrast: 0 }).changes;
  const strong = themeFromInputs({ base: '#f6f1e7', accent: '#3b82f6', contrast: 100 }).changes;
  assert.ok(ratio(strong, 'text-primary', 'black-pure') > ratio(soft, 'text-primary', 'black-pure'));
});

test('only the hue and chroma of the picks are kept; every colour is a plain #rrggbb the resolver can derive from', () => {
  const made = themeFromInputs({ base: '#1c2a4a', accent: '#ff3b30' });
  for (const value of Object.values(made.changes)) assert.match(value, /^#[0-9a-f]{6}$/);
  const grey = themeFromInputs({ base: '#222222', accent: '#888888' }).changes;
  const [r, g, b] = [1, 3, 5].map(at => parseInt(grey['accent-primary'].slice(at, at + 2), 16));
  assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 2, 'a grey accent stays grey');
});

test('bad picks are refused in plain words', () => {
  assert.throws(() => themeFromInputs({ base: 'blue', accent: '#fff' }), /base takes a colour like #3b82f6/);
  assert.throws(() => themeFromInputs({ base: '#fff' }), /Give base, accent/);
  assert.throws(() => themeFromInputs({ base: '#fff', accent: '#000', contrast: 400 }), /Contrast is a number from 0 to 100/);
  assert.throws(() => themeFromInputs({ base: '#fff', accent: '#000', shade: 3 }), /shade is not something a look is made from/);
  assert.equal(rules.roles.every(role => role.tokens.length > 0), true);
});
