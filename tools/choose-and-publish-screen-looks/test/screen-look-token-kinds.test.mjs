// test/screen-look-token-kinds.test.mjs
// Every token of a shipped look whose value is a colour is typed `color`, so the colour ladder (parts/screen-look/colour-ladder.json)
// applies to it: a bad value such as 'banana' degrades to a colour the screen can draw instead of reaching the page as text.
import test from 'node:test';
import assert from 'node:assert/strict';
import looks from '../src/workspace/looks.json' with { type: 'json' };
import { isColour } from '../../screen-look/read-data/colour-ladder.ts';
import { readEditableScreenLookThemes } from '../../screen-look/read-data/read-editable-screen-look-themes.ts';

const tokensOf = theme => theme.payload.tokens;

test('no shipped look types a colour as text', () => {
  const stray = [];
  for (const theme of looks.themes) for (const token of tokensOf(theme)) if (token.kind === 'text' && isColour(token.value)) stray.push(`${theme.payload.id}:${token.key}`);
  assert.deepEqual(stray, []);
});

test('a bad value in a colour token degrades to a drawable colour; the same value in a text token would not', () => {
  const theme = structuredClone(looks.themes[0]);
  const token = tokensOf(theme).find(row => row.key === 'text-primary');
  assert.equal(token.kind, 'color', 'text-primary is a colour');
  token.value = 'banana';
  const [read] = readEditableScreenLookThemes([theme.payload]);
  const drawn = read.tokens.find(row => row.key === 'text-primary').value;
  assert.notEqual(drawn, 'banana');
  assert.equal(isColour(drawn), true, `degraded to ${drawn}`);
  const other = tokensOf(theme).find(row => row.key === 'accent-blue');
  other.value = 'rgb(999, 0, 0)';
  const [again] = readEditableScreenLookThemes([theme.payload]);
  assert.equal(isColour(again.tokens.find(row => row.key === 'accent-blue').value), true, 'a channel past its range degrades too');
});
