// tools/send-messages: inbox pacing and what comes back, on made-up addresses at example.com. Nothing is sent: the
// planner and the sorter only say when to send and what an event means. A pacing row, an outcome row and an event
// source added only as DATA are taken with no code edit.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PACING, eventSourceProblems, outcomeRowProblems, pacingProblems, planSends, sortOutcomes } from '../read-data/inbox-pacing.mjs';

const folder = join(import.meta.dirname, '..');
const people = count => Array.from({ length: count }, (_, index) => `person${index}@example.com`);

test('the shipped pacing, outcome and event-source rows have no problems', () => {
  for (const row of PACING.pacing) assert.deepEqual(pacingProblems(row), [], row.id);
  for (const row of PACING.outcomes) assert.deepEqual(outcomeRowProblems(row), [], row.id);
  for (const row of PACING.event_sources) assert.deepEqual(eventSourceProblems(row), [], row.id);
});

test('a new inbox ramps: day 1 holds the first step\'s cap, spaced by the gap, inside the hours, on allowed days', () => {
  const answer = planSends({ pacing: 'new-inbox-warmup', time_zone: 'UTC', now: '2026-11-06T16:30:00Z', recipients: people(12) });
  // Friday 16:30: 5 fit before 17:00 at 6 minute gaps... the cap is 10, the hours stop at 17:00, so the rest go Monday.
  assert.deepEqual(answer.schedule.slice(0, 5).map(slot => slot.local), ['friday 2026-11-06 16:30', 'friday 2026-11-06 16:36', 'friday 2026-11-06 16:42', 'friday 2026-11-06 16:48', 'friday 2026-11-06 16:54']);
  assert.equal(answer.schedule[5].local, 'monday 2026-11-09 09:00');
  assert.equal(answer.schedule[5].day, 4);
  assert.deepEqual(answer.due_now, ['person0@example.com']);
  const full = planSends({ pacing: 'new-inbox-warmup', time_zone: 'UTC', now: '2026-11-02T08:00:00Z', recipients: people(12) });
  assert.equal(full.schedule.filter(slot => slot.local.startsWith('monday')).length, 10);
  assert.equal(full.schedule[10].local, 'tuesday 2026-11-03 09:00');
  const later = planSends({ pacing: 'new-inbox-warmup', time_zone: 'UTC', now: '2026-11-16T08:00:00Z', first_send_at: '2026-11-02T09:00:00Z', recipients: people(25) });
  assert.equal(later.schedule[0].day, 15);
  assert.equal(later.schedule.filter(slot => slot.local.includes('2026-11-16')).length, 25);   // day 15 allows 35, the hours allow 80
});

test('sends already made today count toward the cap and the gap starts after the last one', () => {
  const history = people(10).map((recipient, index) => ({ recipient: `old${index}@example.com`, at: `2026-11-02T09:${String(index * 5).padStart(2, '0')}:00Z` }));
  const answer = planSends({ pacing: 'new-inbox-warmup', time_zone: 'UTC', now: '2026-11-02T10:00:00Z', history, recipients: ['new@example.com'] });
  assert.equal(answer.schedule[0].local, 'tuesday 2026-11-03 09:00');
  const one = planSends({ pacing: 'new-inbox-warmup', time_zone: 'UTC', now: '2026-11-02T09:01:00Z', history: [{ recipient: 'old@example.com', at: '2026-11-02T09:00:00Z' }], recipients: ['new@example.com'] });
  assert.equal(one.schedule[0].local, 'monday 2026-11-02 09:06');
  assert.deepEqual(one.due_now, []);
});

test('Saturday-only pacing keeps the local hours of the inbox\'s time zone', () => {
  const answer = planSends({ pacing: 'saturday-local', time_zone: 'America/Chicago', now: '2026-11-04T15:00:00Z', recipients: ['a@example.com', 'info@example.org'] });
  assert.deepEqual(answer.schedule.map(slot => [slot.local, slot.at, slot.day]), [
    ['saturday 2026-11-07 08:00', '2026-11-07T14:00:00.000Z', 1],
    ['saturday 2026-11-07 08:08', '2026-11-07T14:08:00.000Z', 1],
  ]);
});

test('suppressed, bounced, complained, replied, recently sent, repeated and malformed addresses are held with why', () => {
  const answer = planSends({
    pacing: 'new-inbox-warmup', time_zone: 'UTC', now: '2026-12-01T10:00:00Z',
    recipients: ['ok@example.com', 'Gone@Example.com', 'spam@example.com', 'talked@example.com', 'recent@example.com', 'ok@example.com', 'not-an-address', 'listed@example.com', 'old@example.com'],
    history: [{ recipient: 'recent@example.com', at: '2026-11-20T10:00:00Z' }, { recipient: 'old@example.com', at: '2026-10-01T10:00:00Z' }],
    outcomes: [{ recipient: 'gone@example.com', kind: 'hard-bounce' }, { recipient: 'spam@example.com', kind: 'unsubscribe' }, { recipient: 'talked@example.com', kind: 'reply' }],
    suppressed: ['listed@example.com'],
  });
  assert.deepEqual(answer.schedule.map(slot => slot.recipient), ['ok@example.com', 'old@example.com']);
  assert.deepEqual(Object.fromEntries(answer.held.map(item => [item.recipient, item.why])), {
    'gone@example.com': 'suppressed: hard-bounce', 'spam@example.com': 'suppressed: unsubscribe', 'talked@example.com': 'reply: answer them yourself',
    'recent@example.com': 'sent to within the last 30 days', 'ok@example.com': 'listed twice', 'not-an-address': 'not an email address', 'listed@example.com': 'suppressed',
  });
});

test('the inbox pauses when its last sends bounce over the share, or draw a complaint', () => {
  const history = people(40).map((recipient, index) => ({ recipient, at: `2026-11-0${2 + (index % 5)}T10:00:00Z` }));
  const bounced = planSends({ pacing: 'new-inbox-warmup', time_zone: 'UTC', now: '2026-11-09T10:00:00Z', history, recipients: ['next@example.com'],
    outcomes: [{ recipient: 'person0@example.com', kind: 'hard-bounce' }] });
  assert.equal(bounced.paused, null);   // 1 of 40 is 2.5%, under the row's 5%
  const two = planSends({ pacing: 'new-inbox-warmup', time_zone: 'UTC', now: '2026-11-09T10:00:00Z', history, recipients: ['next@example.com'],
    outcomes: [{ recipient: 'person0@example.com', kind: 'hard-bounce' }, { recipient: 'person1@example.com', kind: 'hard-bounce' }] });
  assert.match(two.paused.why, /2 of the last 40 sends bounced/);
  assert.deepEqual([two.schedule, two.due_now, two.held[0].why.startsWith('inbox paused')], [[], [], true]);
  const complaint = planSends({ pacing: 'new-inbox-warmup', time_zone: 'UTC', now: '2026-11-09T10:00:00Z', history, recipients: ['next@example.com'], outcomes: [{ recipient: 'person3@example.com', kind: 'complaint' }] });
  assert.match(complaint.paused.why, /1 complaint/);
});

test('bounce share at the line pauses, and is read from the pacing row', () => {
  const history = people(20).map(recipient => ({ recipient, at: '2026-11-02T10:00:00Z' }));
  const strict = { ...PACING.pacing[0], id: 'strict', pause_when: { last_sends: 20, bounce_share_at_least: 0.05, complaints_at_least: 1 } };
  const answer = planSends({ pacing_row: strict, time_zone: 'UTC', now: '2026-11-09T10:00:00Z', history, recipients: ['next@example.com'], outcomes: [{ recipient: 'person0@example.com', kind: 'hard-bounce' }] });
  assert.ok(answer.paused);
});

test('a pacing row the person writes is taken as DATA; a broken one is refused saying what to change', () => {
  const evenings = { id: 'evenings', ramp: [{ from_day: 1, per_day: 2 }], min_gap_minutes: 30, weekdays: ['wednesday'], hours: { from: 18, to: 20 }, leave_address_days: 7, pause_when: { last_sends: 10, bounce_share_at_least: 0.1, complaints_at_least: 1 } };
  const answer = planSends({ pacing_row: evenings, time_zone: 'Europe/Berlin', now: '2026-11-02T00:00:00Z', recipients: people(3) });
  assert.deepEqual(answer.schedule.map(slot => slot.local), ['wednesday 2026-11-04 18:00', 'wednesday 2026-11-04 18:30', 'wednesday 2026-11-11 18:00']);
  assert.throws(() => planSends({ pacing_row: { ...evenings, weekdays: ['someday'] }, time_zone: 'UTC', recipients: people(1) }), /weekdays/);
  assert.throws(() => planSends({ pacing_row: { ...evenings, ramp: [{ from_day: 2, per_day: 1 }] }, time_zone: 'UTC', recipients: people(1) }), /from_day 1/);
  assert.throws(() => planSends({ pacing: 'nope', time_zone: 'UTC', recipients: people(1) }), /new-inbox-warmup, saturday-local/);
  assert.throws(() => planSends({ pacing: 'new-inbox-warmup', time_zone: 'Mars/Base', recipients: people(1) }), /time zone/);
  assert.throws(() => planSends({ pacing: 'new-inbox-warmup', time_zone: 'UTC', recipients: [] }), /recipients/);
});

test('provider events are sorted by the first outcome row that applies, through each event-source row', () => {
  const resend = sortOutcomes({ event_source: 'resend-webhook', events: [
    { type: 'email.bounced', created_at: '2026-11-07T15:00:00Z', data: { to: ['Gone@example.com'], bounce: { type: 'hard', message: 'Mailbox does not exist' } } },
    { type: 'email.delivery_delayed', created_at: '2026-11-07T15:00:00Z', data: { to: ['full@example.com'] } },
    { type: 'email.complained', created_at: '2026-11-07T16:00:00Z', data: { to: ['angry@example.com'] } },
    { type: 'email.delivered', created_at: '2026-11-07T16:00:00Z', data: { to: ['fine@example.com'] } },
    { type: 'email.opened', data: { to: ['seen@example.com'] } },
  ] });
  assert.deepEqual(resend.outcomes.map(outcome => [outcome.recipient, outcome.kind, outcome.action]), [
    ['gone@example.com', 'hard-bounce', 'suppress'], ['full@example.com', 'soft-bounce', 'retry-later'], ['angry@example.com', 'complaint', 'suppress'], ['fine@example.com', 'delivered', 'none'],
  ]);
  assert.deepEqual(resend.retry, [{ recipient: 'full@example.com', at: '2026-11-08T15:00:00.000Z' }]);
  assert.deepEqual(resend.suppress, ['gone@example.com', 'angry@example.com']);
  assert.deepEqual(resend.unmatched, [{ index: 4, recipient: 'seen@example.com', why: 'no outcome row applies' }]);
  const ses = sortOutcomes({ event_source: 'amazon-ses-notification', events: [{ notificationType: 'Bounce', bounce: { bounceType: 'Permanent', bouncedRecipients: [{ diagnosticCode: 'smtp; 550 5.1.1 user unknown' }] }, mail: { destination: ['x@example.com'] } }] });
  assert.equal(ses.outcomes[0].rule, 'hard-bounce');
});

test('replies from the mailbox: a real reply stops the outreach, an auto-reply changes nothing, a stop request suppresses', () => {
  const answer = sortOutcomes({ event_source: 'mailbox-message', events: [
    { from: 'owner@example.com', kind: 'reply', subject: 'Re: your note', text: 'Yes, call me Tuesday.' },
    { from: 'away@example.com', kind: 'reply', subject: 'Automatic reply: Re: your note', text: 'Back Monday.' },
    { from: 'no@example.com', kind: 'reply', subject: 'Re: your note', text: 'Please remove me from your list.' },
    { kind: 'reply', subject: 'no sender' },
  ] });
  assert.deepEqual(answer.outcomes.map(outcome => [outcome.recipient, outcome.kind, outcome.action]), [
    ['owner@example.com', 'reply', 'stop-sequence'], ['away@example.com', 'auto-reply', 'none'], ['no@example.com', 'unsubscribe', 'suppress'],
  ]);
  assert.deepEqual([answer.stop, answer.replies, answer.suppress], [['owner@example.com'], ['owner@example.com'], ['no@example.com']]);
  assert.deepEqual(answer.unmatched, [{ index: 3, why: 'no recipient at from' }]);
  // The sorter's outcomes feed the planner: the replied and unsubscribed are held next time.
  const plan = planSends({ pacing: 'new-inbox-warmup', time_zone: 'UTC', now: '2026-12-01T10:00:00Z', recipients: ['owner@example.com', 'no@example.com', 'away@example.com'], outcomes: answer.outcomes });
  assert.deepEqual(plan.schedule.map(slot => slot.recipient), ['away@example.com']);
});

test('an outcome row or event source added only as DATA is taken; a bad one is refused', () => {
  const rows = [{ id: 'booked', when: [{ field: 'text', pattern: '\\bbook(ed)?\\b' }], kind: 'reply', action: 'hand-to-person' }, ...PACING.outcomes];
  const source = { id: 'crm', fields: { recipient: 'contact.email', type: 'event', text: 'body' } };
  const answer = sortOutcomes({ event_source_row: source, outcome_rows: rows, events: [{ contact: { email: 'c@example.com' }, event: 'reply', body: 'Booked for Friday' }] });
  assert.deepEqual([answer.outcomes[0].rule, answer.outcomes[0].action, answer.replies], ['booked', 'hand-to-person', ['c@example.com']]);
  assert.throws(() => sortOutcomes({ outcome_rows: [{ id: 'x', when: [{ field: 'mood', equals: ['bad'] }], kind: 'reply', action: 'shout' }], events: [] }), /field must be one of.*action must be one of/);
  assert.throws(() => sortOutcomes({ outcome_rows: [{ id: 'x', when: [{ field: 'type', equals: ['bounce'] }], kind: 'soft-bounce', action: 'retry-later' }], events: [] }), /retry_after_hours/);
  assert.throws(() => sortOutcomes({ event_source_row: { id: 'bad', fields: { type: 'kind' } }, events: [] }), /fields.recipient/);
  assert.throws(() => sortOutcomes({}), /events/);
});

const run = (mode, input) => new Promise(resolve => {
  const child = execFile('node', ['do-work/pace-an-inbox.mjs', mode], { cwd: folder }, (error, stdout) => resolve({ code: error?.code ?? 0, last: JSON.parse(stdout.trim().split('\n').at(-1)) }));
  child.stdin.end(JSON.stringify(input));
});

test('the rows\' commands answer their samples with { result } and refuse with { error }', async () => {
  const rows = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records.map(record => record.payload);
  for (const [id, mode] of [['tool:pace-sends-from-an-inbox', 'plan'], ['tool:sort-bounces-and-replies', 'sort']]) {
    const row = rows.find(payload => payload.id === id);
    assert.deepEqual(row.invoke.argv.slice(-1), [mode], id);
    assert.equal(row.invoke.internet, false, id);
    const sample = row.verify[0];
    const ok = await run(mode, sample.input);
    assert.equal(ok.code, 0, id);
    const selected = sample.output_selector.replace(/^\$\./, '').split(/\.|\[(\d+)\]/).filter(Boolean).reduce((value, key) => value?.[key], ok.last.result);
    assert.ok(String(selected).includes(sample.contains), `${id}: ${selected}`);
  }
  const refused = await run('plan', { pacing: 'nope' });
  assert.equal(refused.code, 1);
  assert.match(refused.last.error, /Send pacing/);
  assert.match((await run('other', {})).last.error, /plan.*sort/);
});
