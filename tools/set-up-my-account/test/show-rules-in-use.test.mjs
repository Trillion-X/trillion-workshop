// A profile the person keeps and switches on (record.in_use) applies through the pure owner's showDecision, so the live
// page and the store decide the same way (src/workspace/show-rules.mjs profileRules, rulesInForce). A scoped profile
// applies only in its space, and a profile not on applies to nothing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import data from '../read-data/show-rules.json' with { type: 'json' };
import { changedRecord, showDecision } from '../read-data/show-rules.mjs';
import { initSync, filterRecords } from '../../formula-engine/built-stored-bytes/formula-engine/formula_engine.js';
initSync({ module: readFileSync(new URL('../../formula-engine/built-stored-bytes/formula-engine/formula_engine_bg.wasm', import.meta.url)) });
const filterRows = ({ tree, fields, rows }) => filterRecords({ records: rows, fields, tree });
const NOW = Date.parse('2026-10-13T16:00:00Z');
const thing = { control: 'sidebar.hide', within: ['sidebar', 'sidebar.hide'] };
const quiet = { id: 'quiet', label: 'Quiet', inherits: [], rules: [{ id: 'hide-sidebar', label: 'Hide sidebar', subject: 'control', effect: 'hide', when: null }] };
const hidden = (record, space_id = null) => showDecision({ data, record, subject: 'control', thing, now: NOW, filterRows: filterRows, space_id }).hidden;

test('a kept profile hides only while it is in use, through the pure owner', () => {
  const kept = changedRecord(data, null, { type: quiet }, NOW);
  assert.equal(hidden(kept), false, 'kept but not on');
  const on = changedRecord(data, kept, { use: { type: 'quiet', on: true } }, NOW);
  assert.deepEqual(on.in_use, ['quiet']);
  assert.equal(hidden(on), true, 'on hides the sidebar');
  const off = changedRecord(data, on, { use: { type: 'quiet', on: false } }, NOW);
  assert.equal(off.in_use, undefined, 'an empty in-use list is not kept');
  assert.equal(hidden(off), false, 'off no longer hides it');
});

test('a scoped profile applies only inside its space', () => {
  const scoped = { ...quiet, id: 'quiet-here', scope: { space_id: 'space-a' } };
  const record = changedRecord(data, changedRecord(data, null, { type: scoped }, NOW), { use: { type: 'quiet-here', on: true } }, NOW);
  assert.equal(hidden(record, 'space-a'), true, 'inside its space');
  assert.equal(hidden(record, 'space-b'), false, 'in another space');
  assert.equal(hidden(record), false, 'with no space');
});

test('removing a kept profile takes it out of what is on', () => {
  const record = changedRecord(data, changedRecord(data, changedRecord(data, null, { type: quiet }, NOW), { use: { type: 'quiet', on: true } }, NOW), { remove_type: 'quiet' }, NOW);
  assert.equal(record.in_use, undefined);
  assert.equal(hidden(record), false);
});
