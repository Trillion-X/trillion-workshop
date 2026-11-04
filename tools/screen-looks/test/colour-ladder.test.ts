// tools/screen-looks/read-data/colour-ladder.ts (DATA: tools/screen-looks/read-data/colour-ladder.json): a look from outside never fails
// to open because of one value it cannot draw; the value takes the next rung of the ladder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { clampToBounds, degradeColour, isColour, isSafeText } from '../read-data/colour-ladder.ts';
import { readScreenLookFile, changeScreenLookTokens } from '../read-data/screen-look-record.ts';
import { readEditableScreenLookThemes } from '../read-data/read-editable-screen-look-themes.ts';
import ladder from '../read-data/colour-ladder.json' with { type: 'json' };

const look = (tokens: unknown[]) => ({
  address: 'package::screen-look::published-record::editable-theme::imported',
  payload: { kind: 'screen-look-editable-theme', id: 'imported', name: 'Imported', tokens },
});
const colour = (key: string, value: unknown) => ({ key, label: key, kind: 'color', value });

test('colours the screen can draw are kept exactly as given', () => {
  for (const good of ['#fff', '#ffff', '#f4f0e8', '#f4f0e880', 'rgb(0 128 255)', 'rgba(0, 0, 0, 0.5)', 'rgb(10% 20% 30% / 50%)', 'hsl(210 50% 40%)', 'oklch(0.7 0.15 250)', 'oklch(70% 0.15 250deg)', 'red', 'transparent', 'rebeccapurple', 'color-mix(in srgb, red 40%, white)']) {
    assert.equal(isColour(good), true, good);
    assert.equal(degradeColour(good, '#000000').value, good);
    assert.equal(degradeColour(good, '#000000').rung, 'authored');
  }
});

test('out-of-range and malformed colours are not colours', () => {
  for (const bad of ['rgb(300 0 0)', 'rgb(0 0 -1)', 'rgba(0,0,0,1.5)', '#ff', '#fffff', '#12345g', 'hsl(10 150% 50%)', 'oklch(2 0.1 10)', 'banana', 'url(x)', 'rgb(0 0)', 'rgb(0 0 0 0 0)', '', '  ', 'red; background: blue', 'rgb(1 2 3', 42, null, undefined]) {
    assert.equal(isColour(bad), false, String(bad));
  }
});

test('the ladder: authored, then the default look\'s colour for the token, then the neutral grey', () => {
  assert.deepEqual(degradeColour('rgb(999 0 0)', '#0a0a0a'), { value: '#0a0a0a', rung: 'default' });
  assert.deepEqual(degradeColour('rgb(999 0 0)', undefined), { value: ladder.neutral, rung: 'neutral' });
  assert.deepEqual(degradeColour('rgb(999 0 0)', 'also bad'), { value: ladder.neutral, rung: 'neutral' });
  assert.deepEqual(degradeColour(undefined, '#102030'), { value: '#102030', rung: 'default' });
});

test('numbers past their bounds take the nearest bound; unsafe text is not safe', () => {
  assert.equal(clampToBounds(40, 0, 32), 32);
  assert.equal(clampToBounds(-4, 0, 32), 0);
  assert.equal(clampToBounds(7, 0, 32), 7);
  assert.equal(clampToBounds(7), 7);
  assert.equal(isSafeText('Instrument Sans'), true);
  assert.equal(isSafeText('x; } body { display: none'), false);
  assert.equal(isSafeText('   '), false);
});

test('a downloaded look with bad values still opens: each bad value degrades, every other token is as authored', () => {
  const theme = readScreenLookFile(look([
    colour('backgroundColor', 'rgb(900 0 0)'),
    colour('foregroundColor', '#fafafa'),
    colour('accentMystery', 'not-a-colour'),
    { key: 'defaultBorderRadius', label: 'Radius', kind: 'number', value: 400, min: 0, max: 32 },
    { key: 'defaultPrimaryFontFamily', label: 'Font', kind: 'text', value: 'Inter; } body { display: none' },
    { key: 'ownText', label: 'Own', kind: 'text', value: 'x}{y' },
  ]));
  const by = Object.fromEntries(theme.tokens.map(token => [token.key, token.value]));
  assert.equal(by.backgroundColor, '#0a0a0a', 'a token the default look has takes its default colour');
  assert.equal(by.foregroundColor, '#fafafa', 'a valid token is untouched');
  assert.equal(by.accentMystery, ladder.neutral, 'a token the default look lacks takes the neutral');
  assert.equal(by.defaultBorderRadius, 32);
  assert.notEqual(by.defaultPrimaryFontFamily, undefined);
  assert.equal(String(by.defaultPrimaryFontFamily).includes('}'), false, 'unsafe text takes the default, never reaches a style rule');
  assert.equal('ownText' in by, false, 'unsafe text with no default is left out');
});

test('the shelf reader degrades the same way, and saving stays strict with words', () => {
  const [theme] = readEditableScreenLookThemes([look([colour('backgroundColor', 'oklch(9 9 9)'), colour('foregroundColor', '#fafafa')])]);
  assert.equal(theme.tokens.find(token => token.key === 'backgroundColor')!.value, '#0a0a0a');
  assert.throws(() => changeScreenLookTokens(theme, { foregroundColor: 'rgb(300 0 0)' }), /takes a colour like/);
  assert.equal(changeScreenLookTokens(theme, { foregroundColor: 'rgb(30 40 50)' }).tokens.find(token => token.key === 'foregroundColor')!.value, 'rgb(30 40 50)');
});
