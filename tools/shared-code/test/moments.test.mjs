// Ported from old trillion test/moments.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. The moment step is src/moments.mjs here with its rows in src/moments.json. The four tests of its
// pure parts (momentOf, due, kindOf, textKeyOf, jobOf) are the old ones. The other fifteen ran arrivals through the starting
// rules: old src/inbound.mjs receiving them, and src/automations.mjs makeAutomations with src/starting-rules.mjs
// shippedAutomations running the shipped rules; none of those runs anywhere (searched inbound(, makeAutomations,
// shippedAutomations in trillion-workshop tools/, trillion-apps web/, trillion-rust src/), and every one of those tests (the
// gather_moment ones included) made its arrivals through that door, so they are left out.
import test from 'node:test';
import assert from 'node:assert/strict';
import rows from '../src/moments.json' with { type: 'json' };
import { jobOf, kindOf, momentOf, due, MAX_JOB, textKeyOf, itemOfArrival } from '../src/moments.mjs';

const T = (hhmm, day = '2026-10-08') => `${day}T${hhmm}:00.000Z`;
const fid = n => `12:${String(n).padStart(64, '0')}`;

test('momentOf and due are pure: time, count, span and the kind of file decide', () => {
  const item = (id, hhmm, route = 'Photos') => itemOfArrival(id, { message_id: `m-${id}`, route, source_id: id, at: T(hhmm), files: [{ id: `f-${id}`, name: `${id}.heic` }], said: '' });
  assert.equal(kindOf(item('a', '22:00')).id, 'photo');
  assert.equal(kindOf(item('b', '22:00', 'Screenshots')).id, 'screenshot');
  assert.deepEqual(momentOf(item('c', '22:00', 'Claude'), [], rows), { action: 'alone' });
  const open = [{ id: 'moment:1', row: 'pictures-and-recordings', members: [{ id: 'x', at: T('22:00') }], from: T('22:00'), until: T('22:00'), closed_at: null, closes_at: T('22:10') }];
  assert.equal(momentOf(item('d', '22:29'), open, rows).action, 'join');
  assert.equal(momentOf(item('e', '22:31'), open, rows).action, 'open', 'beyond the window');
  const crowded = [{ ...open[0], members: Array.from({ length: 40 }, (_, n) => ({ id: `x${n}`, at: T('22:00') })) }];
  assert.equal(momentOf(item('f', '22:05'), crowded, rows).action, 'open', 'beyond most_members');
  assert.deepEqual(due(new Date(T('22:09')).getTime(), open), []);
  assert.deepEqual(due(new Date(T('22:10')).getTime(), open), ['moment:1']);
  assert.equal(textKeyOf('Hello'), '', 'too few words to mean the same');
});

test('the job never exceeds 8000 characters and always ends with a pointer to every member', () => {
  const members = Array.from({ length: 40 }, (_, n) => ({ id: `arrival:${n}`, kind: 'arrival', message_id: `message:${n}`, route: 'Photos', at: T('22:00'), files: [{ id: `file:${n}` }] }));
  const items = new Map(members.map(member => [member.id, { ...member, said: 'x'.repeat(300), job: 'long words '.repeat(400), label: '' }]));
  const moment = { id: 'moment:cap', members, from: T('22:00'), until: T('22:00') };
  const job = jobOf(moment, members, items);
  assert.ok(job.length <= MAX_JOB, `${job.length}`);
  for (const member of members) assert.ok(job.includes(member.message_id) && job.includes(`file:${members.indexOf(member)}`));
  assert.match(job, /Read any of them whole with read_message/);
});

test('a screenshot is told by its file name only when the person took it', () => {
  const named = { kind: 'arrival', route: 'Claude', files: [{ name: 'Screenshot 2026-10-08.png' }] };
  assert.equal(kindOf({ ...named, from_person: false }, rows), null, 'an AI\'s file named Screenshot is not one');
  assert.equal(kindOf({ ...named, from_person: true }, rows)?.id, 'screenshot');
  assert.equal(kindOf({ kind: 'arrival', route: 'Screenshots', from_person: false, files: [] }, rows)?.id, 'screenshot', 'the Screenshots route always is');
});

test('a job for hundreds of members keeps its pointer, listing the first ids and counting the rest', () => {
  const members = Array.from({ length: 300 }, (_, n) => ({ id: `arrival:${n}-${'x'.repeat(60)}`, kind: 'arrival', route: 'Photos', at: '2026-10-08T22:00:00.000Z', message_id: `message:${n}-${'y'.repeat(60)}`, files: [{ id: fid(n) }] }));
  const job = jobOf({ id: 'moment:t', members }, members, new Map(members.map(member => [member.id, member])), rows);
  assert.ok(job.length <= MAX_JOB);
  assert.match(job, /Nothing is lost/);
  assert.match(job, /and 280 more \(read them with gather_moment dry_run or read_record/);
  assert.ok(job.trimEnd().endsWith('read_record.') || job.includes('Read any of them whole'), 'the pointer ends the job');
});
