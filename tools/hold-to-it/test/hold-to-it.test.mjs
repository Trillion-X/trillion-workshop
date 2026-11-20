// tool:hold-to-it with no records door handed to the run. Every group, person, agreement and mark here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aroundNow, armAt, evidenceFromHeard, holdToIt, isTimed, marksFor, presentAmong, readSettings, tally } from '../read-data/hold-to-it.mjs';

const settings = readSettings();
const row = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload).find(payload => payload.id === 'tool:hold-to-it');
const policy = {
  defaults: { minutes: 30, time_zone: 'UTC', remind_minutes: 10, check_after_minutes: 30 },
  evidence_before_minutes: 10, evidence_after_minutes: 15, unnamed_prefixes: ['Someone (', 'Unsure ('],
  marks: [
    { id: 'came', label: 'Came', points: 1, when: 'present' },
    { id: 'missed', label: 'Missed the meeting', points: -3, when: 'absent', miss: true },
    { id: 'not-arranged', label: 'Nobody set it up', points: -2, when: 'not_arranged', miss: true },
    { id: 'not-done', label: 'Did not do it', points: -5, when: 'not_done', miss: true },
    { id: 'not-counted', label: 'Not counted', points: 0, when: 'unclear' },
  ],
};
const at = iso => () => Date.parse(iso);
const group = 'bread-club';
const daily = { group, what: 'Meet every morning', agreed_by: ['Priya Shah', 'Omar Reyes', 'Lin'], cadence: { every: 'day', at: '09:00', minutes: 30, time_zone: 'UTC' } };

const hold = (input, now = '2026-03-02T08:00:00Z') => holdToIt({ policy, group, operation: 'keep', ...input }, { now: at(now) });
const check = (agreement, input, now, marks = []) => holdToIt({ policy, group, operation: 'check', agreement, marks, ...input }, { now: at(now) });

test('an agreement with a time is answered with its next meeting, its reminder and its check to arm; one with no time is never guessed', () => {
  const kept = hold(daily);
  assert.match(kept.agreement.agreement_id, /^record:agreements:bread-club:meet-every-morning$/);
  assert.deepEqual(kept.next, { starts_at: '2026-03-02T09:00:00.000Z', ends_at: '2026-03-02T09:30:00.000Z' });
  assert.deepEqual(kept.remind.every, { unit: 'day', at: '08:50', time_zone: 'UTC' });
  assert.deepEqual(kept.check.every, { unit: 'day', at: '10:00', time_zone: 'UTC' });
  assert.equal(kept.remind.schedule_id, 'hold-remind-record-agreements-bread-club-meet-every-morning');
  assert.equal(kept.agreement.agreed_by.length, 3);
  const untimed = hold({ what: 'Read more', agreed_by: ['Lin'], cadence: { every: 'day' } });
  assert.equal(untimed.needs_time, true);
  assert.equal(untimed.next, undefined);
  const once = hold({ what: 'Taste day', agreed_by: ['Lin'], cadence: { every: 'once', at: '14:00', date: '2026-03-09' } });
  assert.equal(once.next.starts_at, '2026-03-09T14:00:00.000Z');
  assert.equal(once.remind.once_at, '2026-03-09T13:50:00.000Z');
  assert.equal(once.check.once_at, '2026-03-09T15:00:00.000Z', 'the check waits the meeting length plus its own minutes');
});

test('keep with a held agreement merges into it, and the answer holds the whole agreement to keep', () => {
  const first = hold({ ...daily, aliases: { Lin: ['l.'] } }).agreement;
  const again = hold({ ...daily, agreement: first, quote: 'we said every morning' }).agreement;
  assert.deepEqual(again.aliases, { Lin: ['l.'] });
  assert.equal(again.quote, 'we said every morning');
  assert.equal(again.agreement_id, first.agreement_id);
});

test('retime moves the next meeting and the times to arm, and a weekly repeat shifts its days with an early reminder', () => {
  const { agreement } = hold({ what: 'Weekly tasting', agreed_by: ['Lin'], cadence: { every: 'week', on: ['monday', 'wednesday'], at: '00:05', time_zone: 'UTC' } });
  const moved = hold({ operation: 'retime', agreement, at: '18:00', because: 'The oven was booked.' });
  assert.equal(moved.said, 'Weekly tasting moved to 18:00. The oven was booked.');
  assert.equal(moved.agreement.cadence.at, '18:00');
  assert.deepEqual(moved.remind.every.on, ['monday', 'wednesday']);
  const early = armAt({ every: 'week', on: ['monday'], at: '00:05', time_zone: 'UTC' }, -10, 0, policy);
  assert.deepEqual(early.every, { unit: 'week', at: '23:55', time_zone: 'UTC', on: ['sunday'] });
  assert.throws(() => hold({ operation: 'retime', agreement, at: '6pm' }), /HH:MM/);
});

test('a meeting is checked from the evidence handed in: who came, who did not, and what a voice with no name does; the answer holds the marks to keep', () => {
  const { agreement } = hold(daily);
  const evidence = [{ name: 'priya', at: '2026-03-02T09:05:00Z' }, { name: 'Omar Reyes', at: '2026-03-02T09:10:00Z' }, { name: 'Lin', at: '2026-03-02T11:30:00Z' }];
  const done = check(agreement, { arranged: true, evidence, read_from: ['call'] }, '2026-03-02T10:00:00Z');
  assert.deepEqual(done.present, ['Priya Shah', 'Omar Reyes']);
  assert.deepEqual(done.absent, ['Lin']);
  assert.deepEqual(done.marks.map(mark => [mark.person, mark.mark, mark.points]), [['Priya Shah', 'came', 1], ['Omar Reyes', 'came', 1], ['Lin', 'missed', -3]]);
  assert.match(done.said, /Lin did not come; Priya Shah and Omar Reyes did\./);
  assert.equal(done.mark_records.length, 3);
  assert.ok(done.mark_records.every(record => record.type === settings.types.mark && record.value.agreement === agreement.agreement_id));
  const again = check(agreement, { arranged: true, evidence, read_from: ['call'] }, '2026-03-02T10:00:00Z');
  assert.deepEqual(again.mark_records.map(record => record.id), done.mark_records.map(record => record.id), 'checking twice answers the same mark ids');
  const unclear = check(agreement, { arranged: true, evidence: [{ name: 'Someone (voice-2)', at: '2026-03-03T09:00:00Z' }, { name: 'Omar', at: '2026-03-03T09:00:00Z' }] }, '2026-03-03T10:00:00Z');
  assert.equal(unclear.unnamed_voices, 1);
  assert.deepEqual(unclear.marks.map(mark => mark.mark), ['not-counted', 'came', 'not-counted']);
  const none = check(agreement, { arranged: false, evidence: [] }, '2026-03-04T10:00:00Z');
  assert.deepEqual(none.marks.map(mark => mark.mark), ['not-arranged', 'not-arranged', 'not-arranged']);
  assert.throws(() => check(agreement, { evidence: [] }, '2026-03-04T10:00:00Z'), /arranged/);
});

test('the scorecard counts one mark per person and day, a correction replaces the older mark, and a run of misses is named', () => {
  const { agreement } = hold(daily);
  const held = [];
  for (const day of ['02', '03']) {
    held.push(...check(agreement, { arranged: true, evidence: [{ name: 'Priya', at: `2026-03-${day}T09:00:00Z` }] }, `2026-03-${day}T10:00:00Z`).mark_records.map(record => record.value));
  }
  const card = holdToIt({ policy, group, operation: 'scorecard', marks: held }, { now: at('2026-03-04T08:00:00Z') });
  assert.deepEqual(card.people.map(person => [person.name, person.points, person.missed_in_a_row]), [['Lin', -6, 2], ['Omar Reyes', -6, 2], ['Priya Shah', 2, 0]]);
  assert.match(card.said, /^Scorecard: Lin -6, Omar Reyes -6, Priya Shah 2\.$/);
  const marked = hold({ operation: 'mark', agreement, person: 'Lin', rule: 'came', date: '2026-03-03', evidence: 'was there, said so in the chat' }, '2026-03-04T09:00:00Z');
  assert.equal(marked.mark_record.value.rule, 'came');
  const corrected = holdToIt({ policy, group, operation: 'scorecard', marks: [...held, marked.mark_record.value] }, { now: at('2026-03-04T10:00:00Z') });
  assert.equal(corrected.people.find(person => person.name === 'Lin').points, -3 + 0 + 1, 'the new mark for the 3rd replaces the missed one');
  const streak = check(agreement, { arranged: true, evidence: [] }, '2026-03-04T10:00:00Z', held);
  assert.match(streak.said, /Omar Reyes has missed 3 in a row\./);
  assert.throws(() => hold({ operation: 'mark', agreement, person: 'Lin', rule: 'dance' }), /which mark \(rule\): came, missed/);
});

test('remind says what is soon, an agreement of another group is refused, and the policy has no default', () => {
  const { agreement } = hold(daily);
  assert.equal(hold({ operation: 'remind', agreement }).said, 'Meet every morning is in 10 minutes. Priya Shah, Omar Reyes and Lin agreed to it.');
  assert.throws(() => hold({ ...daily, policy: undefined, group }), /Give the group's policy/);
  assert.throws(() => holdToIt({ group, operation: 'remind', agreement, policy: { marks: [] } }), /needs marks/);
  assert.throws(() => hold({ operation: 'remind', agreement: { ...agreement, group: 'other-club' } }), /does not belong to this group/);
  assert.throws(() => hold({ operation: 'remind' }), /Say which agreement/);
  assert.throws(() => hold({ operation: 'agreements' }), /operation is one of/);
});

test('the pure parts: cadence windows, presence by first name and alias, marks by what happened, and tallies', () => {
  const weekly = { every: 'week', on: ['monday'], at: '09:00', time_zone: 'America/New_York', minutes: 30 };
  const around = aroundNow(weekly, Date.parse('2026-03-11T12:00:00Z'), policy);
  assert.equal(new Date(around.last.starts).toISOString(), '2026-03-09T13:00:00.000Z', 'Monday 09:00 after the clocks went forward');
  assert.equal(new Date(around.next.starts).toISOString(), '2026-03-16T13:00:00.000Z');
  assert.equal(isTimed({ every: 'once', at: '09:00' }), false);
  assert.deepEqual(presentAmong(['Priya Shah', 'Lin'], [{ name: 'PRIYA' }, { name: 'L.' }], { Lin: ['l.'] }), ['Priya Shah', 'Lin']);
  assert.deepEqual(marksFor({ people: ['A'], present: [], arranged: true, unnamed: 0 }, policy).map(item => item.mark.id), ['missed']);
  assert.throws(() => marksFor({ people: ['A'], present: [], arranged: true }, { marks: [] }), /no mark for "absent"/);
  assert.deepEqual(tally([{ person: 'A', points: 2, agreement: 'x', date: '2026-01-02' }, { person: 'A', points: 5, agreement: 'x', date: '2026-01-02' }], 'showing up'), [{ name: 'A', points: 2, missed_in_a_row: 0, areas: { 'showing up': 2 } }]);
});

test('the row hands the run no records door and asks for the policy, the held agreement and the marks in the request', () => {
  const { invoke, input_schema: schema } = row;
  assert.equal(invoke.records, undefined);
  assert.ok(!JSON.stringify(row).includes('records:'));
  assert.ok(schema.properties.agreement && schema.properties.marks && schema.properties.policy);
  assert.ok(!schema.properties.operation.enum.includes('agreements'));
  const packs = invoke.files.package_files.map(item => item.package ?? item.module);
  for (const name of ['hold-to-it', 'run-work-later-or-on-a-repeat', 'records-door']) assert.ok(packs.includes(name), name);
});

test('a check reads heard turns: the speaker names who came, and voices with no name or several candidates leave nobody marked absent', () => {
  const { agreement } = hold(daily);
  const heard = [{ start: '2026-03-02T09:05:00Z', speaker: 'Priya Shah', me: true, voice: 'p1', score: 0.9, text: 'hello' }, { start: '2026-03-02T09:06:00Z', speaker: 'Unsure (Omar or Lin?)', unsure: ['Omar', 'Lin'], text: 'yes' }];
  const done = check(agreement, { arranged: true, heard, read_from: ['call'] }, '2026-03-02T10:00:00Z');
  assert.deepEqual(done.present, ['Priya Shah']);
  assert.equal(done.unnamed_voices, 1);
  assert.deepEqual(done.marks.map(mark => mark.mark), ['came', 'not-counted', 'not-counted']);
  assert.deepEqual(evidenceFromHeard([{ speaker: ' ', start: 'x' }, { start: 'y' }, { speaker: 'Lin', start: '2026-03-02T09:07:00Z' }]), [{ name: 'Lin', at: '2026-03-02T09:07:00Z' }]);
});
