// A person's own frequency cap for one kind of notice: the notices of the kind already told and the hours since the last
// are facts of show-rules.json subject `notification`, so a rule like "no more than two of these, and not within three
// hours" holds the next one back on a channel through the real tell-the-person path (src/tell-the-person.mjs heldBack).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import operators from '../../formula-engine/rules/rule-operators.json' with { type: 'json' };
import { makeRowFilter } from '../../formula-engine/rules/filter-rows-by-rules.mjs';
import data from '../../set-up-my-account/read-data/show-rules.json' with { type: 'json' };
import { showDecision } from '../../set-up-my-account/read-data/show-rules.mjs';
import { makeTellThePerson } from '../read-data/tell-the-person.mjs';

const rows = JSON.parse(readFileSync(new URL('../read-data/tell-the-person.json', import.meta.url), 'utf8'));
const wasm = () => readFileSync(new URL('../../formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm', import.meta.url));
const filter = makeRowFilter({ operators, wasm });
await filter.load();

const kindIs = value => ({ kind: 'rule', field: 'kind', operator: 'is_any_of', params: { values: [value] } });
const record = { rules: [{ id: 'few-finished', label: 'Few finished notices', subject: 'notification', effect: 'silence',
  when: { kind: 'group', combinator: 'and', negate: false, rules: [kindIs('work-finished'), { kind: 'rule', field: 'times_shown', operator: 'greater_than', params: { value: 1 } }] } }] };

function owner(clock) {
  let notices = [];
  const sent = [];
  const senders = Object.fromEntries([...new Set(rows.channels.map(row => row.sender))].map(name => [name, {
    state: () => ({ ready: true }),
    send: (row, notice) => { sent.push({ channel: row.id, title: notice.title }); return { sent: true, said: 'sent' }; },
  }]));
  const shows = (subject, thing, moment) => showDecision({ data, record, subject, thing, moment, now: clock.at.getTime(), filterRows: filter.filterRowsByRulesNow });
  const tell = makeTellThePerson({
    rows, senders, shows, now: () => clock.at,
    store: { choices: () => null, putChoices: () => {}, notices: () => notices, putNotices: list => { notices = structuredClone(list); } },
  });
  return { tell, sent, notices: () => notices };
}

test('the third notice of a kind is held back on the channels a person caps, and the first two are told', async () => {
  const clock = { at: new Date('2026-10-04T10:00:00Z') };
  const { tell, sent } = owner(clock);
  const outside = () => sent.filter(item => item.channel !== rows.shown_here).length;
  await tell.tell({ kind: 'work-finished', title: 'First', key: 'a' });
  const afterFirst = outside();
  assert.ok(afterFirst > 0);
  clock.at = new Date('2026-10-04T11:00:00Z');
  await tell.tell({ kind: 'work-finished', title: 'Second', key: 'b' });
  assert.equal(outside(), afterFirst * 2, 'the second is told: one earlier is not over the cap');
  clock.at = new Date('2026-10-04T12:00:00Z');
  const third = await tell.tell({ kind: 'work-finished', title: 'Third', key: 'c' });
  assert.equal(outside(), afterFirst * 2, 'the third sends nothing outside the page');
  assert.ok(third.channels.some(item => /Held back by your rule: Few finished notices/.test(item.said ?? '')), 'and says which rule held it');
  const other = await tell.tell({ kind: 'video-made', title: 'A video', key: 'd' });
  assert.ok(other.channels.every(item => !/Held back/.test(item.said ?? '')), 'another kind is not capped');
});

test('the facts are the kept notices of the kind and the hours since the newest', async () => {
  const clock = { at: new Date('2026-10-04T10:00:00Z') };
  let seen = null;
  let notices = [];
  const senders = Object.fromEntries([...new Set(rows.channels.map(row => row.sender))].map(name => [name, { state: () => ({ ready: true }), send: () => ({ sent: true, said: 'sent' }) }]));
  const tell = makeTellThePerson({
    rows, senders, shows: (subject, thing) => { seen = thing; return { silenced: false, rules: [] }; }, now: () => clock.at,
    store: { choices: () => null, putChoices: () => {}, notices: () => notices, putNotices: list => { notices = structuredClone(list); } },
  });
  await tell.tell({ kind: 'work-finished', title: 'One', key: 'a' });
  assert.deepEqual([seen.times_shown, seen.hours_since_last_shown], [0, null]);
  clock.at = new Date('2026-10-04T13:30:00Z');
  await tell.tell({ kind: 'work-finished', title: 'Two', key: 'b' });
  assert.deepEqual([seen.times_shown, seen.hours_since_last_shown], [1, 3.5]);
});
