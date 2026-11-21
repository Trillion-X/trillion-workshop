// tools/check-against-a-persons-rules-and-verdicts/test/units-from-files.test.mjs
//
// A unit may name its words by a kept transcript file (`text_file`, placed by the engine from its identity) instead of
// carrying them; a unit that carries text keeps it, and an empty text_file names no file.
import assert from 'node:assert/strict';
import test from 'node:test';
import { unitsWithTextFiles } from '../do-work/units-from-files.mjs';

test("a unit's text_file becomes its text; a unit with text keeps it; an empty text_file names nothing", () => {
  const files = { '/run/inputs/aa/t.json': JSON.stringify({ text: 'hello there', segments: [] }) };
  const units = unitsWithTextFiles([
    { kind: 'copy', text_file: '/run/inputs/aa/t.json', text: '' },
    { kind: 'copy', text: 'own words', text_file: '/run/inputs/aa/t.json' },
    { kind: 'copy', text_file: '', text: 'no words were heard' },
  ], file => files[file]);
  assert.deepEqual(units, [{ kind: 'copy', text: 'hello there' }, { kind: 'copy', text: 'own words' }, { kind: 'copy', text: 'no words were heard' }]);
});

test('a transcript file with no text is refused in words', () => {
  assert.throws(() => unitsWithTextFiles([{ kind: 'copy', text_file: 'f' }], () => '{"segments": []}'), /no text/);
});
