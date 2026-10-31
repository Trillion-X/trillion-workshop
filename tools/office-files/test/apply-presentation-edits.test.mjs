// tools/office-files: the presentation editor, run over a stand-in presentation runtime that keeps a deck as a JSON file.
// The package this came from had no test; this one proves the request's four edit kinds, the refusal of a slide_order
// that drops or doubles a slide, the match counts (a rule that matches nothing reports 0) and the readback, without a
// real presentation runtime. The deck, its text and its notes are made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const editor = fileURLToPath(new URL('../do-work/apply-declared-presentation-text-edits.mjs', import.meta.url));
const probe = fileURLToPath(new URL('../do-work/describe-presentation-runtime-surface.mjs', import.meta.url));

// A runtime exposing what the editor calls: FileBlob.load, PresentationFile.importPptx / exportPptx, slides.items and
// getItem, shapes.items and add, text.set and toString, speakerNotes.setText and text, delete and moveTo.
const STAND_IN_RUNTIME = `
import { readFileSync, writeFileSync } from 'node:fs';
const makeShape = data => ({
  data,
  text: { set(value) { data.text = value; }, toString() { return data.text ?? ''; }, set fontSize(v) { data.fontSize = v; }, set bold(v) { data.bold = v; },
    set color(v) { data.color = v; }, set alignment(v) { data.alignment = v; }, set verticalAlignment(v) { data.va = v; }, set autoFit(v) { data.autoFit = v; },
    set typeface(v) { data.typeface = v; } },
  delete() { this.slide.shapes.items.splice(this.slide.shapes.items.indexOf(this), 1); },
});
const makeSlide = (deck, data) => {
  const slide = {
    data, deck,
    shapes: { items: [], add(spec) { const shape = makeShape({ spec, text: '' }); shape.slide = slide; slide.shapes.items.push(shape); return shape; } },
    background: { set fill(v) { data.bg = v; } },
    speakerNotes: { text: data.notes ?? '', setText(value) { data.notes = value; this.text = value; } },
    delete() { deck.slides.items.splice(deck.slides.items.indexOf(slide), 1); },
    moveTo(position) { deck.slides.items.splice(deck.slides.items.indexOf(slide), 1); deck.slides.items.splice(position, 0, slide); },
  };
  for (const text of data.texts ?? []) { const shape = makeShape({ text }); shape.slide = slide; slide.shapes.items.push(shape); }
  return slide;
};
export const FileBlob = { load: async path => ({ path }) };
export const PresentationFile = {
  async importPptx(blob) {
    const saved = JSON.parse(readFileSync(blob.path, 'utf8'));
    const deck = { slides: { items: [], getItem(i) { return this.items[i]; } } };
    for (const data of saved.slides) deck.slides.items.push(makeSlide(deck, data));
    return deck;
  },
  async exportPptx(deck) {
    return { async save(path) {
      const slides = deck.slides.items.map(slide => ({ notes: slide.data.notes, bg: slide.data.bg, texts: slide.shapes.items.map(shape => shape.data.text).filter(Boolean),
        typefaces: slide.shapes.items.map(shape => shape.data.typeface).filter(Boolean) }));
      writeFileSync(path, JSON.stringify({ slides }));
    } };
  },
};
`;

function setUp(slides) {
  const work = mkdtempSync(join(tmpdir(), 'office-files-'));
  writeFileSync(join(work, 'runtime.mjs'), STAND_IN_RUNTIME);
  writeFileSync(join(work, 'in.pptx'), JSON.stringify({ slides }));
  return work;
}

const runEditor = (work, request) => {
  writeFileSync(join(work, 'request.json'), JSON.stringify({ runtimeModule: join(work, 'runtime.mjs'), source: join(work, 'in.pptx'), output: join(work, 'out.pptx'), ...request }));
  return spawnSync('node', [editor, '--request', join(work, 'request.json')], { encoding: 'utf8' });
};

const deck = () => [
  { texts: ['Welcome to the harbour tour', 'Doors open at nine'], notes: 'Greet the group' },
  { texts: ['Pricing starts at ten coins'], notes: '' },
  { texts: ['Questions'], notes: 'Leave time' },
];

test('replace_text, notes, delete and slide_order apply by original index and the readback shows the result', () => {
  const work = setUp(deck());
  const run = runEditor(work, {
    slides: [
      { index: 1, replace_text: [{ contains: 'harbour tour', with: 'Welcome to the lighthouse tour' }, { contains: 'never in the deck', with: 'x' }], notes: 'Greet everyone' },
      { index: 2, replace_text: [{ contains: 'ten coins', with: 'Pricing starts at twelve coins' }] },
    ],
    delete: [3],
    slide_order: [2, 1],
  });
  assert.equal(run.status, 0, run.stderr);
  const answer = JSON.parse(run.stdout);
  assert.equal(answer.slideCount, 2);
  assert.deepEqual(answer.edits[0].replace_text, [{ contains: 'harbour tour', matched: 1 }, { contains: 'never in the deck', matched: 0 }]);
  assert.equal(answer.edits[0].notes, true);
  assert.deepEqual(answer.readback.map(slide => slide.title), ['Pricing starts at twelve coins', 'Welcome to the lighthouse tour']);
  assert.equal(answer.readback[1].notes, 'Greet everyone');
  assert.equal(JSON.parse(readFileSync(join(work, 'in.pptx'), 'utf8')).slides.length, 3, 'the source is never modified');
});

test('a slide_order that drops or doubles a slide refuses the whole request and writes no output', () => {
  const work = setUp(deck());
  const run = runEditor(work, { slides: [], delete: [3], slide_order: [1, 1] });
  assert.equal(run.status, 2);
  const refusal = JSON.parse(run.stderr.trim().split('\n').at(-1));
  assert.match(refusal.refused, /every surviving original index exactly once/);
  assert.deepEqual(refusal.expected, [1, 2]);
  assert.throws(() => readFileSync(join(work, 'out.pptx')));
});

test('a rebuilt slide takes its background and text items, with a typeface only when the request names one', () => {
  const work = setUp(deck());
  const run = runEditor(work, {
    fonts: { regular: 'Sample Sans', bold: 'Sample Sans Bold' },
    slides: [{ index: 3, bg: '#112233', text: [{ s: 'Thank you', pos: { left: 0, top: 0, width: 10, height: 2 }, b: true }, { s: 'Write to us', pos: { left: 0, top: 3, width: 10, height: 1 }, typeface: 'Other Face' }] }],
  });
  assert.equal(run.status, 0, run.stderr);
  const saved = JSON.parse(readFileSync(join(work, 'out.pptx'), 'utf8')).slides[2];
  assert.equal(saved.bg, '#112233');
  assert.deepEqual(saved.texts, ['Thank you', 'Write to us']);
  assert.deepEqual(saved.typefaces, ['Sample Sans Bold', 'Other Face']);
  const plain = runEditor(work, { slides: [{ index: 3, text: [{ s: 'No fonts named', pos: {} }] }] });
  assert.equal(plain.status, 0, plain.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(work, 'out.pptx'), 'utf8')).slides[2].typefaces, []);
});

test('a slide index outside the deck is an error and the request needs its flag', () => {
  const work = setUp(deck());
  const outside = runEditor(work, { slides: [{ index: 9, notes: 'x' }] });
  assert.notEqual(outside.status, 0);
  assert.match(outside.stderr, /Slide 9 out of range 1\.\.3/);
  const noFlag = spawnSync('node', [editor], { encoding: 'utf8' });
  assert.equal(noFlag.status, 1);
  assert.match(noFlag.stderr, /--request <path> required/);
});

test('the probe lists the accessor names a runtime exposes on a slide, a shape and the notes', () => {
  const work = setUp(deck());
  const run = spawnSync('node', [probe, join(work, 'runtime.mjs'), join(work, 'in.pptx')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const names = JSON.parse(run.stdout);
  assert.ok(names.slide.includes('shapes') && names.slide.includes('speakerNotes'));
  assert.ok(names.shapeText.includes('set'));
  assert.ok(names.speakerNotes.includes('setText'));
  assert.equal(names.shapeTextString, 'Welcome to the harbour tour');
});
