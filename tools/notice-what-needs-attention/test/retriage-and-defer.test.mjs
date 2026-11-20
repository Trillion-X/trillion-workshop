// Two old behaviours of the attention owner, kept as tests: a classifier answer whose probability is a dead heat defers
// to the next route (old repository test/attention-defer.test.mjs), and waiting jobs the rules now keep as context are
// closed through the tool's own retriage operation (old src/attention.mjs retriageWaiting, its page and resume rules).
import assert from 'node:assert/strict';
import test from 'node:test';
import attentionDataRows from '../src/attention.json' with { type: 'json' };
import { createAttention } from '../read-data/attention.mjs';
import { broughtIn, wordsAgeMinutes } from '../src/brought-in.mjs';
import { noticeAttention } from '../do-work/notice-attention.mjs';

const owner = createAttention(attentionDataRows, { broughtIn, wordsAgeMinutes });
const said = noul => ({ answers: { verdict: { noul } } });

test('with no margin the classifier answer is the old act-or-context threshold', () => {
  assert.equal(attentionDataRows.classify.defer_margin, 0, 'shipped data keeps the measured behaviour');
  assert.deepEqual([0.44, 0.45, 0.9].map(p => owner.classifiedVerdict(said(p))), ['context', 'act', 'act']);
  assert.equal(owner.classifiedVerdict({}), null);
});

test('a probability within the margin of the threshold is a dead heat that defers, and settles on defer_to when nothing is surer', () => {
  const using = { ...attentionDataRows.classify, defer_margin: 0.1, defer_to: 'act' };
  assert.deepEqual([0.2, 0.36, 0.45, 0.54, 0.56, 0.9].map(p => owner.classifiedVerdict(said(p), using)), ['context', 'defer', 'defer', 'defer', 'act', 'act']);
  assert.equal(owner.classifiedAttention(said(0.45), using), 'act');
  assert.equal(owner.classifiedAttention(said(0.45), { ...using, defer_to: 'context' }), 'context');
});

test('retriage closes only the waiting jobs whose words the rules now keep as context, reads one bounded page, and resumes from next_after', async () => {
  const settings = attentionDataRows;
  const history = { history_after_minutes: 1440 };
  const handoffs = [
    { handoff_id: 'h1', input: { arrived: { message_id: 'm1', route: 'ChatGPT', from_person: false } } },
    { handoff_id: 'h2', input: { arrived: { message_id: 'm2', route: 'Listening', from_person: true } }, taken_by: 'ai-one' },
    { handoff_id: 'h3', input: {} },
    { handoff_id: 'h4', input: { arrived: { message_id: 'm4', route: 'Listening', from_person: true, heard: true, voice: { me: true, named: true, name: 'Sam', score: 0.91 } } } },
    { handoff_id: 'h5', input: { arrived: { message_id: 'm5', route: 'Listening', from_person: true, heard: true, voice: { me: true, named: true, name: 'Sam', score: 0.91 } } } },
    { handoff_id: 'h6', input: { arrived: { message_id: 'm6', route: 'Listening', from_person: true, heard: true, voice: { me: true, named: true, name: 'Sam', score: 0.91 } } } },
  ];
  const messages = {
    m1: { app: 'ChatGPT', text: 'Go to the settings page and press Connect; only you can.', at: '2023-04-17T09:12:00.000Z', recorded_at: '2026-10-07T18:00:00.000Z' },
    m2: { text: 'taken already' },
    m4: { text: "where'd you put the coconut oil spray" },
    m5: { text: 'Assistant, talk to me out loud when I ask' },
    m6: { text: 'Could the assistant read this aloud' },
  };
  const answers = {
    "where'd you put the coconut oil spray": said(0.03),
    'Assistant, talk to me out loud when I ask': said(0.9),
  };
  const run = extra => noticeAttention({ operation: 'retriage', settings, history, handoffs, messages, answers, ...extra });

  const first = await run({ limit: 500 });
  assert.equal(first.looked_at, 6, 'one page is at most 50 jobs, and all six here are read');
  assert.deepEqual(first.decided.map(item => [item.handoff_id, item.outcome]), [['h1', 'handled'], ['h4', 'handled']]);
  assert.equal(typeof first.decided[0].reason, 'string');
  assert.equal(first.classified, 3, 'the three heard lines were asked of the classifier');
  assert.equal(first.next_after, 'h6');

  const capped = await run({ limit: 2 });
  assert.deepEqual([capped.looked_at, capped.next_after, capped.decided.map(item => item.handoff_id)], [2, 'h2', ['h1']]);
  const resumed = await run({ limit: 2, after: capped.next_after });
  assert.deepEqual([resumed.looked_at, resumed.next_after, resumed.decided.map(item => item.handoff_id)], [2, 'h4', ['h4']], 'h3 has no words and is passed over; h4 is closed');
  const last = await run({ limit: 2, after: 'h4' });
  assert.deepEqual([last.looked_at, last.decided.map(item => item.handoff_id)], [2, []], 'h5 is act by the classifier and h6 has no answer, so neither is closed');

  const classifiedCap = await run({ limit: 500, classified: 1 });
  assert.equal(classifiedCap.classified, 1, 'the classifier is asked at most `classified` times');
  assert.equal(classifiedCap.next_after, 'h4', 'the page stops before the second classifier question');
});
