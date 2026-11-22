// slides-to-board lays a deck written as slides onto a board of frames that make-slides draws and judges like any board:
// one frame per slide in order, each kind's items inside its own frame, pictures carried as assets, and a request with
// slides instead of a board drawn the same way. Made-up slides only.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { slidesToBoard } from '../do-work/slides-to-board.mjs';

const command = resolve(import.meta.dirname, '../do-work/make-slides.mjs');
const deck = {
  list: [
    { kind: 'words', title: 'Ten emails every morning', lines: ['Each one written from its own website.'], cover: true, dark: true },
    { kind: 'compare', title: 'One prospect, three writers', columns: [
      { head: 'Plain', note: 'Score 40', body: 'Hello.' }, { head: 'Template', note: 'Score 70', body: 'Hi Sam.' }, { head: 'Voiced', body: 'Sam,' }] },
    { kind: 'picture', title: 'Press Approve', picture: '/pictures/screen.png', caption: 'The screen each morning.' },
    { kind: 'table', title: 'Minutes per email', head: ['Way', 'Minutes'], rows: [['By hand', '10'], ['Here', '1']] },
  ],
};

test('one frame per slide, in order, the same size, side by side', () => {
  const { items } = slidesToBoard(deck);
  const frames = items.filter(item => item.extra?.presentationFrame);
  assert.deepEqual(frames.map(frame => frame.extra.presentationFrame.order), [1, 2, 3, 4]);
  assert.ok(frames.every(frame => frame.w === 1920 && frame.h === 1080));
  for (const item of items.filter(item => !item.extra?.presentationFrame)) {
    const frame = frames.find(f => item.memberId.startsWith(`${f.memberId}-`));
    assert.ok(item.x >= frame.x && item.x + item.w <= frame.x + frame.w, `${item.memberId} inside its frame`);
  }
});

test('a dark slide swaps paper and ink; a compare slide has a card per column', () => {
  const { items } = slidesToBoard(deck);
  assert.equal(items.find(item => item.memberId === 's1').extra.style.fill, '--ink');
  assert.equal(items.find(item => item.memberId === 's1-title').extra.style.textColor, '--bg-primary');
  assert.equal(items.filter(item => /^s2-col-\d-card$/.test(item.memberId)).length, 3);
});

test('a picture given as a file becomes an asset the board names', () => {
  const { items, assets } = slidesToBoard(deck);
  assert.equal(items.find(item => item.memberId === 's3-picture').src, 'asset:s3-picture');
  assert.equal(assets['s3-picture'], '/pictures/screen.png');
});

test('a slide of an unknown kind, with no title, or one column to compare is refused', () => {
  assert.throws(() => slidesToBoard({ list: [{ kind: 'poster', title: 'x' }] }), /words, compare, picture or table/);
  assert.throws(() => slidesToBoard({ list: [{ kind: 'words' }] }), /no title/);
  assert.throws(() => slidesToBoard({ list: [{ kind: 'compare', title: 'x', columns: [{ head: 'a', body: 'b' }] }] }), /2 to 4/);
});

test('a request with slides is judged like a board: a long dash on a slide stops it', () => {
  const dir = tempFolder(join(tmpdir(), 'slides-to-board-'));
  writeFileSync(join(dir, 'request.json'), JSON.stringify({ slides: { list: [{ title: 'One crew does it all — removal and prep' }] }, font: 'sans-serif',
    look_values: { '--bg-primary': '#ffffff', '--ink': '#000000', '--accent-primary': '#ff0000', '--bg-surface': '#eeeeee', '--font-display': 'serif', '--font-primary': 'sans-serif' } }));
  const result = spawnSync(process.execPath, [command, join(dir, 'request.json'), '--out', join(dir, 'out')], { encoding: 'utf8' });
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /no-long-dash/);
});

test('every text item is tall enough for its words as the board wraps them, so none ends in an ellipsis', () => {
  const long = 'Your site says you do removal, preparation and installation for general contractors, property managers and restoration teams across four counties.';
  const { items } = slidesToBoard({ list: [{ title: 'A title long enough to wrap onto a second line on a wide slide, and then some more words', lines: [long, long + ' ' + long] }] });
  for (const item of items.filter(item => item.text)) {
    const { fontSize, lineHeight, charWidth, textInset } = item.extra;
    const perLine = Math.floor((item.w - textInset * 2) / (fontSize * charWidth));
    const room = Math.floor((item.h - textInset - 4) / (fontSize * lineHeight));
    let lines = 0;
    let rest = item.text;
    while (rest.length) { lines += 1; if (rest.length <= perLine) break; let cut = rest.lastIndexOf(' ', perLine); if (cut <= 0) cut = perLine; rest = rest.slice(cut).trimStart(); }
    assert.ok(lines <= room, `${item.memberId}: ${lines} lines in room for ${room}`);
  }
});

test('a request with both a board and slides is refused', () => {
  const dir = tempFolder(join(tmpdir(), 'slides-to-board-'));
  writeFileSync(join(dir, 'request.json'), JSON.stringify({ slides: deck, board: { items: [] } }));
  const result = spawnSync(process.execPath, [command, join(dir, 'request.json'), '--out', join(dir, 'out')], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /board or as slides/);
});
