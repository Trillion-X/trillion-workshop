// tools/screen-looks/read-data/tint-look.ts (DATA in tools/screen-looks/read-data/tint-rules.json): one picked colour keeps only its
// hue; lightness is pinned per role and scheme and chroma is clamped, so contrast holds whatever was picked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { changeScreenLookTokens, tintScreenLook } from '../read-data/screen-look-record.ts';
import { DEFAULT_EDITABLE_SCREEN_LOOK_THEME_ID } from '../read-data/read-editable-screen-look-themes.ts';
import { contrastOf, fitChroma, oklchOfRgb, parseHex, tintLook } from '../read-data/tint-look.ts';
import rules from '../read-data/tint-rules.json' with { type: 'json' };

const lch = (text: string) => { const [l, c, h] = /oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/.exec(text)!.slice(1).map(Number); return { l, c, h }; };

test('only the hue survives: very different picks of one hue give the same tokens', () => {
  const dull = tintLook('#800000', 'light').changes;
  const loud = tintLook('#ff0000', 'light').changes;
  assert.equal(lch(dull.primaryColor).h, lch(loud.primaryColor).h, 'same hue');
  assert.equal(lch(dull.primaryColor).c, lch(loud.primaryColor).c, 'chroma is the role limit, not the pick');
  assert.equal(lch(dull.primaryColor).l, 0.52);
  assert.equal(lch(loud.primaryColor).l, 0.52);
  assert.equal(tintLook('#ff0000', 'dark').changes.primaryColor.startsWith('oklch(0.76 '), true);
});

test('contrast is by construction: the accent on the page is readable for every hue in both schemes', () => {
  for (const scheme of ['light', 'dark']) {
    for (let hue = 0; hue < 360; hue += 15) {
      const [r, g, b] = [Math.cos((hue * Math.PI) / 180), Math.cos(((hue - 120) * Math.PI) / 180), Math.cos(((hue + 120) * Math.PI) / 180)].map((v) => 0.5 + 0.5 * v);
      const { changes } = tintLook(`#${[r, g, b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`, scheme);
      const ratio = contrastOf(lch(changes.primaryColor), lch(changes.backgroundColor));
      assert.ok(ratio >= 3, `${scheme} hue ${hue}: ${ratio.toFixed(2)}`);
    }
  }
});

test('a derived colour fits the sRGB gamut, a near-grey pick is neutral on purpose, and bad input says why', () => {
  assert.ok(fitChroma(0.76, 264, 0.18) <= 0.18);
  const blue = lch(tintLook('#0000ff', 'dark').changes.primaryColor);
  const reduced = fitChroma(blue.l, blue.h, 0.4);
  assert.ok(reduced < 0.4, 'blue at high lightness cannot hold that chroma');
  const grey = tintLook('#808080', 'light');
  assert.deepEqual([grey.neutral, grey.hue, grey.changes.primaryColor], [true, null, 'oklch(0.52 0 0)']);
  assert.throws(() => tintLook('red', 'light'), /#rgb or #rrggbb/);
  assert.throws(() => tintLook('#fff', 'sepia'), /scheme is one of light, dark/);
  assert.deepEqual(parseHex('#abc'), parseHex('#aabbcc'));
  assert.ok(oklchOfRgb(1, 1, 1).l > 0.99);
  assert.equal(rules.roles.length, 6);
});

test('the changes go through the look owner: a token the look has is set, one it lacks is refused', () => {
  const theme = { kind: 'screen-look-editable-theme', id: DEFAULT_EDITABLE_SCREEN_LOOK_THEME_ID, name: 'Test', description: '', author: '', is_public: false, is_favorite: false, sections: [],
    tokens: [{ key: 'primaryColor', label: 'Accent', description: '', kind: 'color', value: '#123456' }, { key: 'surfaceColor', label: 'Surface', description: '', kind: 'color', value: '#ffffff' }] } as never;
  const { changes } = tintLook('#3366ff', 'light');
  assert.throws(() => changeScreenLookTokens(theme, changes), /no backgroundColor/);
  const kept = changeScreenLookTokens(theme, { primaryColor: changes.primaryColor, surfaceColor: changes.surfaceColor });
  assert.equal(kept.tokens[0].value, changes.primaryColor);
  console.log('REAL readback of tinted tokens for #3366ff light:', JSON.stringify(changes));
});

test('tintScreenLook sets the tokens the look has and skips the ones it lacks', () => {
  const theme = { kind: 'screen-look-editable-theme', id: 'x', name: 'T', description: '', author: '', is_public: false, is_favorite: false, sections: [],
    tokens: [{ key: 'primaryColor', label: 'Accent', description: '', kind: 'color', value: '#123456' }] } as never;
  const worn = tintScreenLook(theme, '#33aa66', 'dark');
  assert.match(String(worn.tokens[0].value), /^oklch\(0\.76 /);
  assert.equal(worn.tokens.length, 1);
});
