// A rule on the hour reads the hour from the timed-action engine (read-data/show-rules.mjs clockIn), the same zone data
// that checks the zone. Havana keeps UTC-4 after 2026-11-01 in tzdata 2026e and later; Node's and older browsers' ICU
// (tzdata 2025b) still move it to UTC-5, so at 12:00 UTC on 2026-11-08 the engine reads 08:00 and that ICU read 07:00.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import data from '../read-data/show-rules.json' with { type: 'json' };
import { showDecision } from '../read-data/show-rules.mjs';
import { wallTimeOf } from '../../run-work-later-or-on-a-repeat/do-work/timed-action.mjs';
import { initSync, filterRecords } from '../../formula-engine/built-stored-bytes/formula-engine/formula_engine.js';
initSync({ module: readFileSync(new URL('../../formula-engine/built-stored-bytes/formula-engine/formula_engine_bg.wasm', import.meta.url)) });
const filterRows = ({ tree, fields, rows }) => filterRecords({ records: rows, fields, tree });

const AT = Date.parse('2026-11-08T12:00:00.000Z');
const thing = { control: 'sidebar.hide', within: ['sidebar', 'sidebar.hide'] };
const ruleIn = time_zone => ({
  id: 'hide-from-eight', subject: 'control', effect: 'hide', time_zone,
  when: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'hour', operator: 'greater_than', params: { value: 7 } }] },
});
const decide = (time_zone, now = AT) => showDecision({ data, record: { rules: [ruleIn(time_zone)] }, subject: 'control', thing, now, filterRows });

test('the hour a rule reads in Havana is the engine\'s 08:00, not the older zone data\'s 07:00', () => {
  assert.deepEqual(wallTimeOf({ instantMs: AT, zone: 'America/Havana' }), { date: '2026-11-08', time: '08:00' });
  assert.equal(decide('America/Havana').hidden, true, 'hour 8 is past 7: hidden');
  assert.equal(decide('America/Havana', AT - 3_600_000).hidden, false, 'an hour earlier the engine reads 07:00: shown');
});

test('the same rule in New York (UTC-5 then in every zone data) reads 07:00 and shows', () => {
  assert.equal(decide('America/New_York').hidden, false);
});

test('a rule in a zone that is not one gives no clock and fails closed to shown', () => {
  assert.equal(decide('Mars/Base').hidden, false);
});
