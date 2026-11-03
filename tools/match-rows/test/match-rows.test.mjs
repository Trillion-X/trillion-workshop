// tools/match-rows/test/match-rows.test.mjs
//
// The pairing's behaviour: what is confirmed, what is only suggested and why, what is never confirmed on a near tie,
// what is left over on each side, how the caller's own fields, tolerances, weights and id fields change the answer,
// and what is refused. Rows here are invented card lines, receipts, transfers and calendar rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { matchRows as match } from '../do-work/match-rows.mjs';

const cardLines = [
  { id: 'tx1', amount: -42.5, date: '2026-10-01', description: 'POS DEBIT CORNER COFFEE ROASTERS' },
  { id: 'tx2', amount: -120, date: '2026-10-02', description: 'DESIGN TOOLS INC' },
  { id: 'tx3', amount: -9.99, date: '2026-10-03', description: 'Music Stream' },
];
const receipts = [
  { id: 'rc1', amount: 42.5, date: '2026-10-01', description: 'Corner Coffee Roasters receipt' },
  { id: 'rc2', amount: 120, date: '2026-10-06', description: 'Design Tools invoice' },
  { id: 'rc3', amount: 55, date: '2026-10-03', description: 'Ride Share' },
];

test('card lines are matched to receipts by amount, date and shared words: a sure pair is matched, a weaker one only suggested, the rest left over', () => {
  const r = match({ left: cardLines, right: receipts });
  assert.deepEqual(r.matched.map(pair => [pair.left, pair.right]), [['tx1', 'rc1']]);
  assert.ok(r.matched[0].confidence >= 0.9);
  assert.deepEqual(r.suggested.map(pair => [pair.left, pair.right]), [['tx2', 'rc2']]);
  assert.ok(r.suggested[0].confidence < 0.9 && r.suggested[0].confidence >= 0.5);
  assert.deepEqual(r.unmatched_left, ['tx3']);
  assert.deepEqual(r.unmatched_right, ['rc3']);
  assert.deepEqual(r.kept, []);
});

test('every pair says per field why: the words it shared, how far apart the dates were', () => {
  const r = match({ left: cardLines, right: receipts });
  assert.ok(r.matched[0].reasons.some(reason => /shares corner, coffee, roasters/.test(reason.said)));
  const weaker = r.suggested[0].reasons;
  assert.deepEqual(weaker.map(reason => reason.field), ['amount', 'date', 'description']);
  assert.match(weaker.find(reason => reason.field === 'date').said, /4 days apart, within 5/);
  assert.match(weaker.find(reason => reason.field === 'amount').said, /is the same/);
});

test('the words the rules ignore (card, debit, inc, payment) never count as shared', () => {
  const r = match({
    fields: [{ left: 'note', kind: 'words', required: true }],
    left: [{ id: 'a', note: 'card payment debit' }],
    right: [{ id: 'b', note: 'online purchase from the co' }],
  });
  assert.deepEqual([...r.matched, ...r.suggested], []);
  assert.deepEqual(r.unmatched_left, ['a']);
});

test('both sides of a transfer are paired when the caller says the amounts mirror each other, and the same-signed row is not', () => {
  const r = match({
    fields: [{ left: 'amount', kind: 'number', compare: 'opposite', required: true }, { left: 'date', kind: 'date', tolerance: 3 }],
    left: [{ id: 'out', amount: -500, date: '2026-10-01' }],
    right: [{ id: 'in', amount: 500, date: '2026-10-02' }, { id: 'same', amount: -500, date: '2026-10-01' }],
  });
  assert.deepEqual([...r.matched, ...r.suggested].map(pair => pair.right), ['in']);
  assert.deepEqual(r.unmatched_right, ['same']);
});

test('two equally good candidates are never confirmed: the pair is suggested with the other as its alternative', () => {
  const r = match({
    left: [{ id: 'a', amount: 10, date: '2026-10-01', description: 'coffee' }],
    right: [{ id: 'x', amount: 10, date: '2026-10-01', description: 'coffee' }, { id: 'y', amount: 10, date: '2026-10-01', description: 'coffee' }],
  });
  assert.equal(r.matched.length, 0);
  assert.equal(r.suggested.length, 1);
  assert.equal(r.suggested[0].alternatives.length, 1);
  assert.equal(r.suggested[0].alternatives[0].left, 'a');
  assert.deepEqual(r.unmatched_right.length, 1);
});

test('a field marked required rules a pair out when it disagrees or is missing', () => {
  const r = match({
    left: [{ id: 'a', amount: 10, date: '2026-10-01' }, { id: 'b', date: '2026-10-01' }],
    right: [{ id: 'x', amount: 11, date: '2026-10-01' }, { id: 'y', amount: 10, date: '2026-10-01' }],
  });
  assert.deepEqual([...r.matched, ...r.suggested].map(pair => [pair.left, pair.right]), [['a', 'y']]);
  assert.deepEqual(r.unmatched_left, ['b']);
});

test('a number within its tolerance counts for less the further apart it is', () => {
  const fields = [{ left: 'amount', kind: 'number', tolerance: 1, required: true }];
  const near = match({ fields, left: [{ id: 'a', amount: 10 }], right: [{ id: 'x', amount: 10.2 }] });
  const far = match({ fields, left: [{ id: 'a', amount: 10 }], right: [{ id: 'x', amount: 10.9 }] });
  const same = match({ fields, left: [{ id: 'a', amount: 10 }], right: [{ id: 'x', amount: 10 }] });
  assert.equal(same.matched[0].confidence, 1);
  assert.ok(near.matched[0].confidence > far.suggested[0].confidence);
  assert.deepEqual(match({ fields, left: [{ id: 'a', amount: 10 }], right: [{ id: 'x', amount: 11.5 }] }).unmatched_left, ['a']);
});

test('pairs already made are kept, their rows are not offered again, and they are not left unmatched', () => {
  const r = match({ already: [{ left: 'a', right: 'x' }], left: [{ id: 'a', amount: 10, date: '2026-10-01' }], right: [{ id: 'x', amount: 10, date: '2026-10-01' }] });
  assert.equal(r.matched.length + r.suggested.length, 0);
  assert.deepEqual(r.kept, [{ left: 'a', right: 'x' }]);
  assert.deepEqual(r.unmatched_left, []);
  assert.deepEqual(r.unmatched_right, []);
});

test('many bills can go to one payment when the caller asks for many_to_one, and each bill is used once', () => {
  const r = match({
    mode: 'many_to_one',
    fields: [{ left: 'vendor', kind: 'same', required: true }],
    left: [{ id: 'pay', vendor: 'Acme' }],
    right: [{ id: 'b1', vendor: 'acme' }, { id: 'b2', vendor: 'ACME ' }, { id: 'b3', vendor: 'Other' }],
  });
  assert.deepEqual(r.matched.map(pair => pair.right).sort(), ['b1', 'b2']);
  assert.deepEqual(r.unmatched_right, ['b3']);
});

test('nested field paths and the caller\'s own id fields pair a calendar event with a timesheet entry', () => {
  const r = match({
    left_id: 'event.uid', right_id: 'entry_id',
    fields: [{ left: 'event.start', right: 'started', kind: 'date', tolerance: 0.1, required: true }],
    left: [{ event: { uid: 'e1', start: '2026-10-01T09:00:00Z' } }],
    right: [{ entry_id: 't1', started: '2026-10-01T09:00:00Z' }],
  });
  assert.deepEqual(r.matched.map(pair => [pair.left, pair.right]), [['e1', 't1']]);
});

test('the caller\'s thresholds change what is confirmed and what is offered at all', () => {
  const left = [{ id: 'tx2', amount: -120, date: '2026-10-02', description: 'DESIGN TOOLS INC' }];
  const right = [{ id: 'rc2', amount: 120, date: '2026-10-06', description: 'Design Tools invoice' }];
  assert.equal(match({ left, right, confirm_at: 0.7 }).matched.length, 1);
  assert.equal(match({ left, right, suggest_at: 0.99 }).suggested.length, 0);
  assert.equal(match({ left, right, rules: { confirm_at: 0.7 } }).matched.length, 1);
});

test('a request that cannot be matched is refused in words', () => {
  assert.throws(() => match({ fields: [] }), /at least one field/);
  assert.throws(() => match(null), /must be an object/);
  assert.throws(() => match({ left: 'rows', right: [] }), /left must be a list of rows/);
  assert.throws(() => match({ left: [{ amount: 1 }], right: [] }), /left row 1 has no id/);
  assert.throws(() => match({ left: [], right: [{ id: 'a' }, { id: 'a' }] }), /right has the id a more than once/);
});

test('the row\'s sample run answers through the command the row runs', () => {
  const folder = new URL('../', import.meta.url);
  const row = JSON.parse(readFileSync(new URL('tool-rows.json', folder), 'utf8')).records[0].payload;
  const [sample] = row.verify;
  const door = fileURLToPath(new URL('../records-door/do-work/run-an-export.mjs', folder));
  const module = fileURLToPath(new URL('do-work/match-rows.mjs', folder));
  assert.deepEqual(row.invoke.argv.slice(-2), ['/opt/match-rows/do-work/match-rows.mjs', 'matchRows']);
  const run = spawnSync('node', [door, module, 'matchRows'], { input: JSON.stringify(sample.input), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const answer = JSON.parse(run.stdout.trim().split('\n').at(-1));
  assert.equal(answer.result.matched[0].right, sample.contains);
  const refused = spawnSync('node', [door, module, 'matchRows'], { input: JSON.stringify({ left: [{ name: 'no id' }], right: [] }), encoding: 'utf8' });
  assert.match(JSON.parse(refused.stdout.trim()).error, /left row 1 has no id/);
});
