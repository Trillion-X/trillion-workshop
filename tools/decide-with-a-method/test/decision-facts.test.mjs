// The pure facts of one decision (read-data/decision-facts.mjs), ported from the old app's src/screen.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { actionFacts, carriedOutFacts, day, decisionFacts, followedFacts, lines, pursuitChange, resultFacts, sourceOf, stanceOf, statusOf, toneOf } from '../read-data/decision-facts.mjs';

const words = {
  heading: 'Do you agree?', ask: 'Do you agree with this decision?', why_label: 'Why, in your words (optional)',
  earlier: 'On an earlier version of this decision.', followed_heading: 'What came after',
};
const record = {
  id: 'd1', created_at: '2026-11-09T10:00:00Z', decided_at: '2026-11-10T09:00:00Z', decision_generation: 1,
  input: {
    goal: 'Sell more', evidence: [{ claim: 'Sales fell', ref: 'https://example.test/report' }, { claim: 'Old', ref: 'x', retracted_at: '2026-11-11T00:00:00Z' }],
    options: [{ id: 'a', label: 'Raise prices' }, { id: 'b', label: 'Hold' }],
  },
  decision: { option_id: 'a', move: 'Raise prices by 5%', reason: 'Margin', next_action: 'Update the price list', success_measure: 'Margin up' },
  status: 'needs_decision',
};

test('day says a date as a short English day in UTC, and nothing for a value that is not a date', () => {
  assert.equal(day('2026-11-10T09:00:00Z'), 'Nov 10, 2026');
  assert.equal(day('2026-11-10'), 'Nov 10, 2026');
  assert.equal(day('2026-1'), null);
  assert.equal(day(undefined), null);
});

test('sourceOf reads a web address, a page reference without its time, and nothing else', () => {
  assert.deepEqual(sourceOf('https://example.test/a'), { href: 'https://example.test/a', page: false });
  assert.deepEqual(sourceOf('page:https://example.test/a@2026-11-10T09:00:00Z'), { href: 'https://example.test/a', page: true });
  assert.equal(sourceOf('file:abc'), null);
  assert.equal(sourceOf(null), null);
});

test('pursuitChange splits "<title>: now <now>; should be <after>" and returns null for other text', () => {
  assert.deepEqual(pursuitChange('Shop: now slow; should be fast'), { title: 'Shop', now: 'slow', after: 'fast' });
  assert.equal(pursuitChange('just a note'), null);
});

test('toneOf maps met to good, failed to attention and anything else to quiet', () => {
  assert.equal(toneOf('met'), 'good');
  assert.equal(toneOf('failed'), 'attention');
  assert.equal(toneOf('unknown'), 'quiet');
});

test('statusOf shows the day with its tone, and an empty label for no date', () => {
  assert.deepEqual(statusOf('2026-11-10T09:00:00Z', 'good'), { label: 'Nov 10, 2026', tone: 'good' });
  assert.deepEqual(statusOf(undefined), { label: '', tone: 'quiet' });
});

test('lines joins the present lines and gives null when none is present', () => {
  assert.equal(lines(['a', null, '', 'b']), 'a\nb');
  assert.equal(lines([null, '']), null);
});

test('followedFacts lists records and calls newest first, leaves out stand records and the made step, and gives failed calls no day', () => {
  const trace = {
    records: [{ at: '2026-11-12T00:00:00Z', ref: 'r1', kind: 'message', title: 'Chat' }, { at: '2026-11-13T00:00:00Z', ref: 'r2', kind: 'stance' }],
    steps: [
      { at: '2026-11-11T00:00:00Z', seq: 3, link: 'used', label: 'Check', agent_name: 'Ops', ok: false },
      { at: '2026-11-14T00:00:00Z', seq: 4, link: 'made', label: 'Made it' },
    ],
  };
  const rows = followedFacts(trace);
  assert.deepEqual(rows.map(row => row.id), ['record-r1', 'call-3']);
  assert.equal(rows[1].failed, true);
  assert.equal(rows[1].status, null);
  assert.equal(rows[1].detail, 'Check · Ops');
  assert.deepEqual(rows[0].status, { label: 'Nov 12, 2026', tone: 'quiet' });
  assert.deepEqual(followedFacts(null), []);
});

test('followedFacts keeps the newest thirty', () => {
  const records = Array.from({ length: 35 }, (_, index) => ({ at: `2026-11-${String(index % 28 + 1).padStart(2, '0')}T00:00:00Z`, ref: `r${index}`, kind: 'note' }));
  assert.equal(followedFacts({ records, steps: [] }).length, 30);
});

test('actionFacts joins an action to its latest observation by action_key and to its report by action_ref', () => {
  const action = {
    key: 'k1', description: 'Send the invoice', state: 'running', recorded_at: '2026-11-10T08:00:00Z',
    owner_result: { status: 'completed', ref: 'res-1' },
  };
  const facts = actionFacts({
    actions: [action],
    observations: [
      { action_key: 'k1', observed_at: '2026-11-10T10:00:00Z', result: 'failed', summary: 'early', source_ref: 'https://example.test/x' },
      { action_key: 'k1', observed_at: '2026-11-11T10:00:00Z', result: 'met', summary: 'Paid' },
    ],
    reports: [{ action_ref: 'res-1', reported_at: '2026-11-11T12:00:00Z', result: 'partly', summary: 'Sent' }],
  });
  assert.equal(facts.length, 1);
  assert.equal(facts[0].title, 'Send the invoice');
  assert.equal(facts[0].completion, 'completed');
  assert.deepEqual(facts[0].outcome, { result: 'it worked', summary: 'Paid' });
  assert.deepEqual(facts[0].reported, { result: 'partly', summary: 'Sent' });
  assert.deepEqual(facts[0].status, { label: 'Nov 11, 2026', tone: 'good' });
  assert.equal(facts[0].source, null);
  assert.equal(facts[0].detailed, true);
});

test('actionFacts gives an action with nothing observed or reported a quiet day from its record time', () => {
  const [fact] = actionFacts({ actions: [{ description: 'Wait', state: 'queued', recorded_at: '2026-11-10T08:00:00Z' }] });
  assert.equal(fact.completion, null);
  assert.equal(fact.detailed, false);
  assert.deepEqual(fact.status, { label: 'Nov 10, 2026', tone: 'quiet' });
});

test('carriedOutFacts marks a wall as attention and a done step as done', () => {
  const rows = carriedOutFacts({ carried_out: [
    { state: 'done', what_happened: 'sent', at: '2026-11-10T00:00:00Z' },
    { state: 'wall', what_happened: 'locked', at: '2026-11-11T00:00:00Z' },
  ] });
  assert.deepEqual(rows.map(row => [row.done, row.status.tone]), [[true, 'quiet'], [false, 'attention']]);
});

test('resultFacts puts checks, reports and observations oldest first and leaves out reports that answer an action', () => {
  const rows = resultFacts({
    outcome_checks: [{ checked_at: '2026-11-12T00:00:00Z', result: 'failed', reason: 'Down', observer: 'person', source_ref: 'page:https://example.test/p@2026-11-12T00:00:00Z' }],
    reports: [{ reported_at: '2026-11-10T00:00:00Z', result: 'met', summary: 'Done' }, { action_ref: 'res-1', reported_at: '2026-11-09T00:00:00Z', result: 'met' }],
    observations: [{ observed_at: '2026-11-11T00:00:00Z', result: 'unknown', summary: 'Seen', source_ref: 'https://example.test/o' }],
  });
  assert.deepEqual(rows.map(row => row.kind), ['report', 'observation', 'check']);
  assert.equal(rows[2].looked_at, 'https://example.test/p');
  assert.equal(rows[2].by_person, true);
  assert.deepEqual(rows[2].status, { label: 'Nov 12, 2026', tone: 'attention' });
  assert.deepEqual(rows[1].source, { href: 'https://example.test/o', page: false });
  assert.equal(rows[0].result, 'it worked');
});

test('stanceOf takes its rows from where-a-person-stands, three stands with partly, and marks the stand taken on this version', () => {
  const facts = stanceOf(record, { stance: 'partly', at: '2026-11-12T00:00:00Z', why: 'Mostly', decision_generation: 1 }, words);
  assert.deepEqual(facts.choices.map(choice => choice.id), ['agree', 'disagree', 'partly']);
  assert.equal(facts.choices.find(choice => choice.id === 'partly').primary, true);
  assert.equal(facts.said, 'You partly agree with this.');
  assert.equal(facts.earlier_said, null);
  assert.equal(facts.why, 'Mostly');
  assert.equal(facts.detailed, true);
  assert.deepEqual(facts.status, { label: 'Nov 12, 2026', tone: 'quiet' });
  assert.deepEqual(facts.words, { heading: 'Do you agree?', ask: 'Do you agree with this decision?', why_label: 'Why, in your words (optional)', earlier: 'On an earlier version of this decision.' });
});

test('stanceOf says a stand taken on an earlier version is earlier, and not primary', () => {
  const facts = stanceOf({ ...record, decision_generation: 2 }, { stance: 'agree', at: '2026-11-12T00:00:00Z', decision_generation: 1 }, words);
  assert.equal(facts.said, null);
  assert.equal(facts.earlier_said, 'You agree with this.');
  assert.equal(facts.detailed, true);
  assert.equal(facts.choices.some(choice => choice.primary), false);
});

test('stanceOf with no stand taken has no status and no primary choice', () => {
  const facts = stanceOf(record, null, words);
  assert.equal(facts.status, null);
  assert.equal(facts.said, null);
  assert.equal(facts.choices.some(choice => choice.primary), false);
});

test('decisionFacts says a record with no input is not found, not a TypeError', () => {
  assert.deepEqual(decisionFacts({ record: { id: 'x' }, words }), { kind: 'decision', asked: true, found: false });
  assert.deepEqual(decisionFacts({ record: null, words }), { kind: 'decision', asked: true, found: false });
});

test('decisionFacts shows the decision, its chosen option, its evidence and the screen words for a decision not yet carried out', () => {
  const facts = decisionFacts({ record, words });
  assert.equal(facts.found, true);
  assert.equal(facts.followed_heading, 'What came after');
  assert.equal(facts.status_words, 'Open: not decided yet');
  assert.equal(facts.copy_href, '/work/decisions/d1/copy');
  assert.deepEqual(facts.decision, { name: 'Raise prices by 5%', from_option: 'Raise prices', reason: 'Margin', next_action: 'Update the price list', success_measure: 'Margin up', recheck_day: null });
  assert.deepEqual(facts.options, [{ label: 'Raise prices', chosen: true }, { label: 'Hold', chosen: false }]);
  assert.deepEqual(facts.evidence, [
    { claim: 'Sales fell', withdrawn: false, source: { href: 'https://example.test/report', page: false } },
    { claim: 'Old', withdrawn: true, source: null },
  ]);
  assert.deepEqual(facts.worked, []);
  assert.equal(facts.started, 'Nov 9, 2026');
  assert.equal(facts.acted, false);
  assert.equal(facts.latest_result, null);
  assert.equal(facts.waiting, null);
  assert.equal(facts.stance.said, null);
  assert.equal(facts.stance.status, null);
  assert.equal(facts.followed.length, 0);
});

test('decisionFacts with a stand, worked steps and a waiting question keeps each part as its own fact', () => {
  const facts = decisionFacts({
    record: { ...record, outcome_question: { question: 'Did prices hold?' }, scratchpad: [{ text: 'Check Q3', written_at: '2026-11-11T00:00:00Z' }] },
    stance: { stance: 'agree', at: '2026-11-12T00:00:00Z', decision_generation: 1 },
    worked: [{ step_id: 's1', question: 'What is the margin?', rows: [{ label: 'Answer', text: '12%' }, { label: 'Source', text: 'Ledger' }], checks: [] }],
    words,
  });
  assert.deepEqual(facts.worked, [{ question: 'What is the margin?', detail: 'Answer: 12%\nSource: Ledger' }]);
  assert.deepEqual(facts.waiting, { question: 'Did prices hold?' });
  assert.equal(facts.stance.said, 'You agree with this.');
  assert.deepEqual(facts.notes, [{ title: 'Check Q3', status: { label: 'Nov 11, 2026', tone: 'quiet' } }]);
});

test('decisionFacts names the pursuit changes it cites and the latest result in the words of the result', () => {
  const facts = decisionFacts({
    record: {
      ...record, status: 'needs_outcome', decided_at: '2026-11-10T09:00:00Z',
      cited_pursuits: { p1: 'Shop: now slow; should be fast', p2: 'no change text' },
      reports: [{ reported_at: '2026-11-13T00:00:00Z', result: 'met', summary: 'Went well' }],
      carried_out: [{ state: 'done', what_happened: 'Updated the list', at: '2026-11-11T00:00:00Z', decision_generation: 1 }],
    },
    words,
  });
  assert.deepEqual(facts.pursuits, [{ title: 'Shop', now: 'slow', after: 'fast' }]);
  assert.deepEqual(facts.latest_result, { result: 'it worked', summary: 'Went well' });
  assert.equal(facts.acted, true);
});
