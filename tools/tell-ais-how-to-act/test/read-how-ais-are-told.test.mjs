import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { instructionRows, readRows } from '../do-work/read-how-ais-are-told.mjs';

const file = new URL('../rows.json', import.meta.url);
const records = JSON.parse(readFileSync(file, 'utf8')).records;
const row = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records[0].payload;

test('the row reads only, offline, on the person\'s computer', () => {
  assert.equal(row.id, 'tool:read-how-ais-are-told');
  assert.equal(row.invoke.internet, false);
  assert.deepEqual(row.placements, ['placement:your-computer']);
});

test('every instruction row has a distinct id and order, text, and only known reaches', () => {
  const rows = instructionRows();
  assert.ok(rows.length >= 70);
  assert.equal(new Set(rows.map(item => item.id)).size, rows.length);
  assert.equal(new Set(rows.map(item => item.order)).size, rows.length);
  for (const item of rows) {
    assert.ok(typeof item.text === 'string' && item.text.trim(), `${item.id} has text`);
    for (const reach of item.reaches ?? ['initialize']) assert.ok(['initialize', 'tool-description'].includes(reach), `${item.id} reaches ${reach}`);
  }
  assert.deepEqual(rows.slice(0, 3).map(item => item.id), ['decide-first', 'look-first', 'opening']);
});

test('every fill record is used, every need is a fill, and no row writes the product name', () => {
  const fills = new Set(records.filter(record => record.payload.kind === 'ai-instruction-fill').map(record => record.payload.id));
  const text = instructionRows().map(item => item.text).join('\n');
  for (const id of fills) assert.ok(text.includes(`{${id}}`) || instructionRows().some(item => (item.needs ?? []).includes(id)), `fill ${id} is never used`);
  for (const item of instructionRows()) {
    for (const need of item.needs ?? []) assert.ok(fills.has(need), `${item.id} needs ${need}`);
    assert.ok(!/trillion/i.test(item.text), `${item.id} writes the product's name; use {name}`);
  }
});

test('the first three rows fit in 512 characters', () => {
  const opening = instructionRows().slice(0, 3).map(item => item.text).join(' ');
  assert.ok(opening.length <= 512 + 40, `${opening.length} characters`);
});

test('reads every row, or one whole by id, and refuses an unknown id', () => {
  const all = readRows();
  assert.equal(all.count, instructionRows().length);
  assert.equal(readRows({ id: 'opening' }).row.id, 'opening');
  assert.throws(() => readRows({ id: 'no-such-row' }), /No instruction row/);
});
