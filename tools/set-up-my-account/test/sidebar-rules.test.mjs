// Ported from the retired repository test/sidebar-rules.test.mjs (b6ae0ebf81): its first two tests, assertions unchanged. The third test (the lists drawn show New first, which bundles src/workspace/sidebar-lists.ts) belongs to the sidebar's own tool, tools/organize-the-sidebar, and is not run here.
// The sidebar's lists a rule fills (src/workspace/sidebar-rules.mjs over surfaces.json), decided by the real formula
// engine: New holds a row first offered in the last 7 days, a row an AI left a count on and a row kept new until a
// date, and says when its answer next changes; a list shown only until a date goes at that date; the lists drawn
// show New's rows in their own lists too.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { initSync, filterRecords } from '../../formula-engine/built-stored-bytes/formula-engine/formula_engine.js';
import { decideSidebarRules } from '../read-data/sidebar-rules.mjs';
import surfaces from '../../shared-code/src/workspace/screens.mjs';

initSync({ module: readFileSync(new URL('../../formula-engine/built-stored-bytes/formula-engine/formula_engine_bg.wasm', import.meta.url)) });
const filterRows = ({ tree, fields, rows }) => filterRecords({ records: rows, fields, tree });
const DAY = 86_400_000;
const NOW = Date.parse('2026-10-02T12:00:00Z');
const tool = (id, extra = {}) => ({ id, label: id, kind: 'placeable-surface', source: { kind: 'tool', tool_id: id, group: 'content-plan' }, ...extra });
const rows = [
  tool('tool:old'),
  tool('tool:fresh'),
  tool('tool:noted'),
  tool('tool:featured', { sidebar_new_until: '2026-10-05T00:00:00Z' }),
  tool('tool:navigation-projection', { sidebar_new_eligible: false }),
];
const records = {
  'sidebar-seen': { 'tool:old': 0, 'tool:fresh': NOW - 2 * DAY, 'tool:noted': 0, 'tool:featured': 0, 'tool:navigation-projection': NOW - 2 * DAY },
  'sidebar-notes': { 'tool:noted': { message: 'Two posts wait', count: 2 } },
};
const readRecord = name => records[name] ?? null;

test('New holds what is new by the rules in surfaces.json, and says when that next changes', async () => {
  const decided = await decideSidebarRules({ data: surfaces, rows, readRecord, now: NOW, filterRows });
  assert.deepEqual(decided.holds.new.sort(), ['tool:featured', 'tool:fresh', 'tool:noted']);
  // The soonest turn: tool:featured's date passes (Oct 5) before tool:fresh is 7 days old (Oct 7).
  assert.equal(decided.next_change_at, Math.min(Date.parse('2026-10-05T00:00:00Z'), NOW - 2 * DAY + 7 * DAY));
  const later = await decideSidebarRules({ data: surfaces, rows, readRecord, now: decided.next_change_at + 1, filterRows });
  assert.ok(later.holds.new.length < decided.holds.new.length, 'past that moment a row leaves New on its own');
});

test('a list shown only until a date goes at that date', async () => {
  const data = {
    ...surfaces,
    sidebar_row_facts: [...surfaces.sidebar_row_facts, { id: 'days_left', kind: 'number', path: ['shown_until'], time: 'days_until' }],
    sidebar_collections: [{ id: 'launch-week', name: 'Launch week', shown_until: '2026-10-03T00:00:00Z', shown_when: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'days_left', operator: 'greater_than', params: { value: 0 } }] } }],
  };
  const before = await decideSidebarRules({ data, rows, readRecord, now: NOW, filterRows });
  assert.deepEqual(before.hidden, []);
  assert.equal(before.next_change_at, Date.parse('2026-10-03T00:00:00Z'));
  const after = await decideSidebarRules({ data, rows, readRecord, now: Date.parse('2026-10-03T00:00:01Z'), filterRows });
  assert.deepEqual(after.hidden, ['launch-week']);
});

