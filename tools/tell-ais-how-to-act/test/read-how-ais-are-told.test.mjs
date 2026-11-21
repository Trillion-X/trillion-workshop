import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { instructionRows, readRows } from '../do-work/read-how-ais-are-told.mjs';

const file = new URL('../rows.json', import.meta.url);
const records = JSON.parse(readFileSync(file, 'utf8')).records;
// The folder's rows also hold the row declaring the instruction list (kind ai-instruction-source); this is the reader's.
const row = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records
  .map(record => record.payload).find(payload => payload.id === 'tool:read-how-ais-are-told');

test('the row reads only, offline, on the person\'s computer', () => {
  assert.equal(row.id, 'tool:read-how-ais-are-told');
  assert.equal(row.invoke.internet, false);
  assert.deepEqual(row.placements, ['placement:your-computer']);
});

test('every instruction row has a distinct id and order, text, and only known reaches', () => {
  const rows = instructionRows();
  // 70 until Nov 18 2026, when the three rows that sent AIs to the job tools of the retired record store were removed.
  assert.ok(rows.length >= 67);
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
  assert.ok(opening.length <= 512, `${opening.length} characters`);
  assert.match(opening, /do_one_thing_in_my_account/);
  assert.match(opening, /do_one_thing_in_my_account\(\{method,request_key,input\}\)/);
  assert.match(opening, /tools:list.*tools:run.*secrets:put\/remove\/sign.*wake:\*.*sharing\.\*/);
  assert.match(opening, /address @own-records, method instructions:read/);
  assert.match(opening, /Old names.*not call IDs/);
  // Nov 21 2026: the find comes first, in the bytes every app reads and in the one tool's description, so no AI says it
  // cannot before it has searched (a fresh Codex made 21 calls and gave up; ChatGPT spent an hour).
  assert.match(opening, /For any job, first tools:list \{words:/);
  assert.match(opening, /never say you can't before it/);
  assert.ok(instructionRows()[0].reaches.includes('tool-description'), 'the find reaches the tool description too');
});

test('tool instructions use discovered Workshop IDs and the current door schemas', () => {
  const byId = new Map(instructionRows().map(item => [item.id, item]));
  const details = byId.get('current-resource-tool-entrypoint')?.text;
  assert.ok(details, 'the current entrypoint and schemas are documented');
  assert.match(details, /tools:list input \{words\?,after\?,runs_here\?\}/);
  assert.match(details, /best matches come first/);
  assert.match(details, /tools:list \{tool:ID\} returns that row.s \{id,label,job,description,input_schema,output_schema,runs_here\}/);
  assert.match(details, /tools:run input \{tool:ID,input:\{\.\.\.\}\}/);
  assert.match(details, /their own stores .* in each store's own language/);
  assert.match(details, /input's `stored`.*under `keep`/);
  assert.doesNotMatch(details, /records:(read|list|write)/);
  assert.match(details, /preserve lessons, context and original payload provenance/);
  assert.doesNotMatch(details, /tool:details/);
});

test('reads every row, or one whole by id, and refuses an unknown id', () => {
  const all = readRows();
  assert.equal(all.count, instructionRows().length);
  assert.equal(readRows({ id: 'opening' }).row.id, 'opening');
  assert.throws(() => readRows({ id: 'no-such-row' }), /No instruction row/);
});

test('the declared result selects the reader output itself', () => {
  const whole = readRows({ id: 'decide-first' });
  assert.ok(whole.row, 'the program emits the output object directly');
  assert.equal(Object.hasOwn(whole, 'result'), false, 'there is no nested result envelope');
  assert.equal(row.result_selector, '$', 'the container runner selects from raw JSON stdout');
});

test('every AI is told to start a lane only from its task row, and to run it in the cloud unless it needs this Mac', () => {
  const lane = instructionRows().find(item => item.id === 'start-a-lane-only-from-its-task-row');
  assert.ok(lane, 'the row exists');
  assert.ok(lane.order > 40 && lane.order < 45, 'it is told right after the connect-time job rows');
  assert.ok((lane.reaches ?? ['initialize']).includes('initialize'));
  assert.match(lane.text, /launch-a-lane-job\.py/);
  assert.match(lane.text, /cloud/);
  assert.match(lane.text, /where-agents-run/);
  assert.match(lane.text, /Needs this Mac:/);
});
