// make-slides on a made-up board: slides in story order at the frame's size, look variables read from the look,
// an asset carried as its bytes, filled words in place of the template's, and the words kept as inert records.
// With a Chromium and tools/headless-browser beside this folder, it also prints the PDF and a picture of each page.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { keepInFiles } from '../do-work/make-slides.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const command = resolve(import.meta.dirname, '../do-work/make-slides.mjs');
const frame = (id, order) => ({ memberId: id, x: (order - 1) * 2000, y: 0, w: 1280, h: 720, text: '', extra: { presentationFrame: { order }, style: { fill: '--paper', stroke: '--paper' } } });
const note = (id, x, y, w, h, text, extra = {}) => ({ memberId: id, x, y, w, h, text, extra: { style: { fill: 'none', stroke: 'none', textColor: '--ink' }, ...extra } });
const board = [
  frame('second', 2),
  frame('first', 1),
  note('first-title', 80, 80, 1000, 200, 'Made for Example Co and its 70 people.', { fontSize: 56, fontWeight: 600, fontFamily: '--font-display' }),
  { memberId: 'first-logo', x: 1100, y: 600, w: 120, h: 60, src: 'asset:mark', extra: { imageFit: 'contain', style: { fill: 'none', stroke: 'none' } } },
  note('second-body', 2080, 80, 1000, 300, 'One line.\nA second line.', { fontSize: 32 }),
  note('second-swatch', 2080, 500, 600, 80, 'Ink is {{--ink}}.', { fontSize: 24 }),
];
const values = { '--paper': '#f5f1ea', '--ink': '#202020', '--font-display': 'Tidewater Serif, serif', '--font-primary': 'Quay Sans, sans-serif' };

function setUp(extra = {}) {
  const dir = tempFolder(join(tmpdir(), 'make-slides-'));
  writeFileSync(join(dir, 'board.json'), JSON.stringify({ items: board }));
  writeFileSync(join(dir, 'values.json'), JSON.stringify({ palette: values }));
  writeFileSync(join(dir, 'look.css'), "@font-face{font-family:'Tidewater Serif';src:url(data:font/woff2;base64,AAAA) format('woff2')}:root{--paper:#f5f1ea}");
  writeFileSync(join(dir, 'mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>');
  writeFileSync(join(dir, 'request.json'), JSON.stringify({ board: 'board.json', title: 'Example deck', look_values: 'values.json', look_css: 'look.css', assets: { mark: 'mark.svg' }, ...extra }));
  return dir;
}

const run = (dir, ...more) => JSON.parse(execFileSync(process.execPath, [command, join(dir, 'request.json'), '--out', join(dir, 'out'), ...more], { encoding: 'utf8' }).trim().split('\n').pop());

test('frames become slides in story order, at the frame size, wearing the look', () => {
  const dir = setUp();
  const out = run(dir);
  assert.deepEqual(out.slides.map(slide => slide.order), [1, 2]);
  const first = readFileSync(out.slides[0].svg, 'utf8');
  assert.match(first, /viewBox="0 0 1280 720" width="1280" height="720"/);
  assert.match(first, /fill="#f5f1ea"/);
  assert.match(first, /font-size="56" font-family="Tidewater Serif, serif" font-weight="600" fill="#202020"/);
  assert.match(first, /href="data:image\/svg\+xml;base64,/);
  assert.match(first, /preserveAspectRatio="xMidYMid meet"/);
  const second = readFileSync(out.slides[1].svg, 'utf8');
  assert.match(second, /<tspan[^>]*>One line\.<\/tspan><tspan[^>]*>A second line\.<\/tspan>/);
  assert.match(second, />Ink is #202020.</);
  const html = readFileSync(out.html, 'utf8');
  assert.match(html, /@page\{size:1280px 720px;margin:0\}/);
  assert.match(html, /@font-face\{font-family:'Tidewater Serif'/);
  const words = JSON.parse(/<script type="application\/json" id="slide-words">(.*?)<\/script>/s.exec(html)[1]);
  assert.deepEqual(words.map(word => [word.id, word.fields.slide]), [['first-title', 1], ['second-body', 2], ['second-swatch', 2]]);
});

test('a filled word template replaces an item\'s words, line breaks kept', () => {
  const tokens = ['Made', 'for', 'Harbour Freight', 'and', 'its', '64', 'people.'].map((word, i) => ({ id: `t${i}`, record: 'first-title', dims: { 'onscreen.word': word } }));
  const dir = setUp({ words_from: 'piece.json' });
  writeFileSync(join(dir, 'piece.json'), JSON.stringify({ tokens: [...tokens,
    { id: 'b0', record: 'second-body', dims: { 'onscreen.word': 'First.' } }, { id: 'b1', record: 'second-body', dims: { 'onscreen.word': '↵' } },
    { id: 'b2', record: 'second-body', dims: { 'onscreen.word': 'Then' } }, { id: 'b3', record: 'second-body', dims: { 'onscreen.word': 'this.' } }] }));
  const out = run(dir);
  const first = readFileSync(out.slides[0].svg, 'utf8');
  assert.match(first, />Made for Harbour Freight and<\/tspan><tspan[^>]*>its 64 people\.</);
  assert.doesNotMatch(first, /Example Co/);
  assert.match(readFileSync(out.slides[1].svg, 'utf8'), />First\.<\/tspan><tspan[^>]*>Then this\.</);
});

test('a request that names frames makes only those slides, in its order', () => {
  const out = run(setUp({ frames: ['second'] }));
  assert.equal(out.slides.length, 1);
  const only = readFileSync(out.slides[0].svg, 'utf8');
  assert.match(only, /A second line\./);
  assert.doesNotMatch(only, /Example Co/);
  assert.doesNotMatch(readFileSync(out.html, 'utf8'), /Example Co/);
  const both = run(setUp({ frames: ['second', 'first'] }));
  assert.match(readFileSync(both.slides[0].svg, 'utf8'), /A second line\./);
  assert.match(readFileSync(both.slides[1].svg, 'utf8'), /Example Co/);
  assert.throws(() => run(setUp({ frames: ['second-body'] })), /frames names second-body, which is not a frame/);
});

test('a look variable the look does not have, an unknown asset or a frame of another size stops the run', () => {
  const missing = setUp();
  writeFileSync(join(missing, 'values.json'), JSON.stringify({ palette: { '--paper': '#fff' } }));
  assert.throws(() => run(missing), /names --[a-z-]+, which the look does not have/);
  const asset = setUp({ assets: {} });
  assert.throws(() => run(asset), /asset mark/);
  const sizes = setUp();
  writeFileSync(join(sizes, 'board.json'), JSON.stringify([frame('a', 1), { ...frame('b', 2), w: 800 }]));
  assert.throws(() => run(sizes), /every slide is 1280 x 720/);
});

const runStep = file => JSON.parse(execFileSync(process.execPath, [command, file], { encoding: 'utf8' }).trim().split('\n').pop());

test('a workflow step\'s input carries the request inline or as a path, and makes the same slides as the file', () => {
  const dir = setUp();
  const fromFile = run(dir);
  const inline = { board, look_values: { palette: values }, look_css: 'look.css', assets: { mark: 'mark.svg' }, title: 'Example deck' };
  writeFileSync(join(dir, 'inline.json'), JSON.stringify({ request: inline, out: 'inline' }));
  writeFileSync(join(dir, 'by-path.json'), JSON.stringify({ request: 'request.json', out: 'by-path' }));
  for (const [step, folder] of [['inline.json', 'inline'], ['by-path.json', 'by-path']]) {
    const made = runStep(join(dir, step));
    assert.deepEqual(made.slides.map(slide => slide.order), [1, 2]);
    assert.ok(made.slides[0].svg.startsWith(join(dir, folder)), `${step} writes to its out folder`);
    assert.equal(readFileSync(made.slides[0].svg, 'utf8'), readFileSync(fromFile.slides[0].svg, 'utf8'));
    assert.equal(readFileSync(made.slides[1].svg, 'utf8'), readFileSync(fromFile.slides[1].svg, 'utf8'));
  }
});

// A stand-in for the signed-in command: it answers the Files operations the keep makes and logs each call.
function fakeCli(dir, { identity, size, log }) {
  const file = join(dir, 'fake-cli.mjs');
  writeFileSync(file, `#!/usr/bin/env node
import { appendFileSync, statSync } from 'node:fs';
const args = process.argv.slice(2);
const op = JSON.parse(args[args.indexOf('tools:run') + 1]).call;
const upload = args.indexOf('--upload');
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ name: op.name, pin: args[args.indexOf('--pin') + 1], upload: upload < 0 ? null : args[upload + 1] }) + '\\n');
const answers = {
  write_file_start: { state: 'open' },
  write_file_piece: { next_offset: upload < 0 ? 0 : statSync(args[upload + 1]).size },
  write_file_finish: { state: 'finished' },
  find_file: { identity: ${JSON.stringify(identity)}, byte_length: ${size} },
};
process.stdout.write(JSON.stringify({ tool: 'tool:your-files', result: { structuredContent: answers[op.name] } }));
`);
  chmodSync(file, 0o755);
  return file;
}

test('the PDF is kept in Files under /Slides with its identity, through the signed-in command', () => {
  const dir = setUp();
  const pdf = join(dir, 'deck.pdf');
  writeFileSync(pdf, '%PDF-1.4 stand-in');
  const identity = makeHashCodeHexFromBytes(readFileSync(pdf));
  const log = join(dir, 'calls.jsonl');
  const name = keepInFiles(pdf, { title: 'Example deck', call: [process.execPath, fakeCli(dir, { identity, size: 17, log })], pin: 'pin-1' });
  assert.equal(name, `/Slides/example-deck-${identity.slice(3, 15)}.pdf`);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.map(call => call.name), ['write_file_start', 'write_file_piece', 'write_file_finish', 'find_file']);
  assert.deepEqual(calls[1], { name: 'write_file_piece', pin: 'pin-1', upload: pdf });
  assert.ok(calls.every(call => call.pin === 'pin-1'));
});

// The Chromium the browser tools' tests drive (test-helpers/chromium.mjs), or BROWSER_EXECUTABLE.
const helper = await import('../../../test-helpers/chromium.mjs').catch(() => null);
const browser = process.env.BROWSER_EXECUTABLE || helper?.chromiumExecutable();
const library = resolve(import.meta.dirname, '../../headless-browser/devtools.mjs');
test('with a browser, the deck prints to one PDF page per slide and a picture of each', { skip: !browser || !existsSync(library) }, () => {
  const dir = setUp();
  const out = run(dir, '--pdf', '--pictures', '--browser', browser);
  const pdf = readFileSync(out.pdf, 'latin1');
  assert.equal((pdf.match(/\/Type\s*\/Page\b/g) ?? []).length, 2);
  assert.equal(out.pictures.length, 2);
  assert.equal(readFileSync(out.pictures[0]).subarray(1, 4).toString(), 'PNG');
});
