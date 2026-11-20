// test/read-pane-and-feel-settings.test.mjs
//
// The Panes and Feel settings read (tool:read-pane-and-feel-settings) answers the DATA as it stands. The old look
// screen drew these sections from its own rows (tool:look, sections panes and feel); no old test asserted them, so
// these assertions are the new home's own: the defaults and rows are read, every moment's feel is defined, and a
// broken DATA file is refused.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FEEL_ROWS_PATH, PANE_SIZES_PATH, readPaneAndFeelSettings, readPaneAndFeelSettingsFrom } from '../do-work/read-pane-and-feel-settings.mjs';

test('the panes come from pane-sizes.json: the defaults every person starts with and the settings rows, as the file has them', () => {
  const answer = readPaneAndFeelSettings();
  const file = JSON.parse(readFileSync(PANE_SIZES_PATH, 'utf8'));
  assert.deepEqual(answer.panes.defaults, file.defaults);
  assert.deepEqual(answer.panes.sections, file.sections);
  assert.equal(answer.panes.defaults.snap_on, true);
});

test('every settings row a person edits has a default in pane-sizes.json', () => {
  const { panes } = readPaneAndFeelSettings();
  for (const section of panes.sections) for (const setting of section.settings ?? []) {
    assert.ok(setting.key in panes.defaults, `${setting.key} has no default`);
  }
});

test('the feel comes from tools/feel: its outputs, its feels and its moments, and every moment names a feel that exists', () => {
  const { feel } = readPaneAndFeelSettings();
  const file = JSON.parse(readFileSync(FEEL_ROWS_PATH, 'utf8'));
  assert.deepEqual(feel.outputs, file.outputs);
  assert.deepEqual(feel.feels, file.feels);
  assert.equal(feel.moments.length, file.moments.length);
  for (const moment of feel.moments) assert.ok(moment.feel in feel.feels, `${moment.id} names ${moment.feel}`);
});

test('a moment that names a feel the DATA does not define is refused, never drawn', () => {
  const dir = tempFolder(join(tmpdir(), 'panes-feel-'));
  try {
    const broken = join(dir, 'feel-moments.json');
    const file = JSON.parse(readFileSync(FEEL_ROWS_PATH, 'utf8'));
    file.moments = [...file.moments, { id: 'ghost', label: 'Ghost', on: { event_kind: 'ghost' }, feel: 'no-such-feel' }];
    writeFileSync(broken, JSON.stringify(file));
    assert.throws(() => readPaneAndFeelSettingsFrom({ panes: PANE_SIZES_PATH, feel: broken }), /does not define: ghost/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
