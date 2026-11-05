// Ported from trillion test/catalogue-screen-look.test.mjs (tag old-trillion-before-worker-retire).
//
// Look is a catalogue screen (tool:look, moved from records/marketplace-screens.json) with nothing to read: its layout is
// the three sections that lend the shared Screen look, Panes and Feel parts, each keeping its own choice in the person's
// records. The layout draws what src/account-screens.mjs lookScreen drew (fixtures/look-descriptions.json, the tag's
// golden), and GET /work/api/screens/look is the generic screen host's answer for this row.
//
// Adapted: the layout holds no binding or structural node, so the screen host's drawLayout places it as it is; the test
// checks that instead of drawing it through the old Worker's evaluator. The old row also ran, as the account action
// screen-looks; a Workshop screen row runs nothing (it has no invoke), so that assertion is now that it has none.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
const golden = JSON.parse(readFileSync(new URL('./fixtures/look-descriptions.json', import.meta.url), 'utf8')).cases;
const screenRow = rows.find(row => row.id === 'tool:look');

// Every `$kind` node in a layout (a binding, or each, choose, join, apply): what drawLayout would evaluate.
const drawnNodes = value => (Array.isArray(value) ? value.flatMap(drawnNodes)
  : value && typeof value === 'object' ? [...(typeof value.$kind === 'string' ? [value.$kind] : []), ...Object.values(value).flatMap(drawnNodes)] : []);

test('the layout draws the description lookScreen drew', () => {
  assert.equal(golden.length, 1);
  assert.deepEqual(drawnNodes(screenRow.screen.layout), [], 'nothing in the layout is evaluated, so it is drawn as it is');
  assert.deepEqual(screenRow.screen.layout, golden[0].description);
  assert.deepEqual(screenRow.screen.layout.sections.map(section => section.part), ['screen-look', 'pane-sizes', 'feel']);
});

test('the screen reads nothing and is a reads screen the host answers by its own id', () => {
  assert.equal(screenRow.kind, 'ai-tool-descriptor');
  assert.equal(screenRow.screen.kind, 'reads');
  assert.deepEqual(screenRow.screen.reads, []);
  assert.equal(screenRow.screen.shown_when, undefined, 'every account is shown it');
  assert.equal(screenRow.invoke, undefined, 'a screen row runs nothing');
});
