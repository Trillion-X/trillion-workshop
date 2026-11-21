// make-slides judges every line on a slide before it draws anything: a long dash, small-print hedging, a small label
// above the title or a line breaking the person's own rule row stops the run with each finding; plain words, a hyphen,
// a caption under a picture and a subtitle below the title are drawn. Made-up boards only.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { slideLines, wordFindings } from '../do-work/make-slides.mjs';

const command = resolve(import.meta.dirname, '../do-work/make-slides.mjs');
const frame = { memberId: 's1', x: 0, y: 0, w: 1280, h: 720, text: '', extra: { presentationFrame: { order: 1 }, style: { fill: 'none', stroke: 'none' } } };
const line = (id, y, h, text, fontSize) => ({ memberId: id, x: 80, y, w: 1100, h, text, extra: { fontSize, style: { fill: 'none', stroke: 'none' } } });
const title = line('s1-title', 120, 120, 'Ten emails every morning, each written for one business.', 48);

function draw(items, request = {}) {
  const dir = tempFolder(join(tmpdir(), 'words-a-reader-sees-'));
  writeFileSync(join(dir, 'board.json'), JSON.stringify({ items: [frame, ...items] }));
  writeFileSync(join(dir, 'request.json'), JSON.stringify({ board: 'board.json', font: 'sans-serif', ...request }));
  return spawnSync(process.execPath, [command, join(dir, 'request.json'), '--out', join(dir, 'out')], { encoding: 'utf8' });
}

const refused = (result, rule) => {
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /break the reader's rules, so nothing was drawn/);
  assert.match(result.stderr, new RegExp(rule));
};

test('a long dash or an en dash on any slide stops the deck', () => {
  refused(draw([title, line('s1-body', 300, 100, 'One crew does it all — removal, prep and install.', 28)]), 'no-long-dash');
  refused(draw([title, line('s1-body', 300, 100, 'Open 8–5 every weekday.', 28)]), 'no-long-dash');
});

test('small-print hedging stops the deck', () => {
  refused(draw([title, line('s1-foot', 620, 40, 'Drafts from research, not launched.', 20)]), 'no-disclaimer');
  refused(draw([line('s1-title', 120, 120, 'Nothing goes out without you', 48)]), 'no-disclaimer');
});

test('a small label above the title stops the deck, whatever the item is named', () => {
  refused(draw([line('s1-top', 60, 40, 'From market research, for Example Co', 24), title]), 'no-label-above-title');
});

test("the person's own rule row is judged with the shipped rows", () => {
  const rules = [{ id: 'no-fragment-promise', words: ['it comes with the screen'], count_at_most: 0, says: 'A fragment sentence.' }];
  refused(draw([title, line('s1-body', 300, 100, 'Your AI uses it. It comes with the screen.', 28)], { words_rules: rules }), 'no-fragment-promise');
});

test('plain words, a hyphen, a caption under a picture and a subtitle below the title are drawn', () => {
  const result = draw([
    title,
    line('s1-sub', 260, 60, 'Each one quotes a line from their own site.', 30),
    line('s1-caption', 600, 40, 'You press skip here, and that business is never written to again.', 18),
    line('s1-warranty', 660, 40, 'Our 1-year installation warranty is on the sheet.', 18),
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim().split('\n').pop()).slides.length, 1);
});

test('a line as large as the title above it is no label; a slide with no sized words has none', () => {
  const lines = slideLines([line('a', 40, 60, 'Riverside, this morning', 40), title], 1);
  assert.deepEqual(lines.map(entry => entry.kind), ['slide-words', 'slide-words']);
  assert.deepEqual(slideLines([{ ...title, extra: {} }], 1).map(entry => entry.kind), ['slide-words']);
  assert.deepEqual(wordFindings(lines), []);
});
