// test/said-done.test.mjs
//
// Ported from the old source tree test/said-done.test.mjs (commit b6ae0ebf8). The unit outcomes
// are kept: a clear yes settles the row in the person's words, a clear no does nothing, AI or someone else's words and
// history brought in are never asked, an unsure or missing answer is handed to the AIs once, a settled row is left
// alone, and a long message is asked about the stretch around its words. The end-to-end outcomes (through the person
// store's inbound door, and the Downloads rule) are NOT here: they need the store that calls weighSaidDone, which this
// folder does not have yet (see README and the handoff row).
import assert from 'node:assert/strict';
import test from 'node:test';
import { broughtIn } from '../../notice-what-needs-attention/src/brought-in.mjs';
import { rowsNamed, saidDoneSettings, thePersonsWords, weighSaidDone } from '../src/said-done.mjs';

const list = { id: 'chores', label: 'Chores', row_type: 'chores', title_field: 'what', fields: [
  { id: 'what', kind: 'text' }, { id: 'done_when', kind: 'text' }, { id: 'closed_because', kind: 'text' },
  { id: 'finish', kind: 'choice', choices: ['Tap done', 'Tell the AIs'] },
  { id: 'status', kind: 'choice', choices: ['Waiting', 'Done'], settles: ['Done'], starts: 'Waiting' },
] };
const rowId = 'record:chores:plugin';
const now = new Date().toISOString();
const message = (text, extra = {}) => ({ id: 'message:1', app: 'Claude Code', conversation_id: 'c-1', speaker: 'person', text, at: now, recorded_at: now,
  about: [{ kind: 'record', id: rowId, via: 'entity-ingest' }], ...extra });

function world(answers, { status = 'Waiting' } = {}) {
  const asked = [], settled = [], handed = [];
  const records = { [rowId]: { what: 'Upload the plugin', done_when: 'The plugin is listed in the store', status } };
  return {
    asked, settled, handed,
    io: {
      read: id => records[id] ?? null,
      listFor: ({ record_id }) => (record_id.startsWith('record:chores:') ? list : null),
      broughtIn,
      names: { finish: 'Tell the AIs' },
      ask: async input => { asked.push(input); return answers(input); },
      settle: async change => { settled.push(change); return { kept: [] }; },
      handOff: async job => { handed.push(job); return { handoff: { handoff_id: `h_${handed.length}` } }; },
    },
  };
}
const byWords = table => input => { for (const [words, answer] of table) if (input.state.includes(words)) return answer; return null; };

test('"I already did this last week" settles the row, quoting the person\'s words', async () => {
  const { io, asked, settled, handed } = world(byWords([['I already did this last week', 0.93]]));
  const result = await weighSaidDone({ message: message('Upload the plugin: I already did this last week.'), ...io });
  assert.equal(asked.length, 1);
  assert.match(asked[0].state, /I already did this last week/);
  assert.match(asked[0].state, /"Upload the plugin"/, 'the row it names is in the question');
  assert.match(asked[0].state, /The plugin is listed in the store/, 'and what done means for it');
  assert.equal(asked[0].questions.verdict.instructions, saidDoneSettings.classify.question);
  assert.deepEqual(settled, [{ list_id: 'chores', row_id: 'plugin', values: {
    status: 'Done', closed_because: 'You said it was done: "Upload the plugin: I already did this last week." (Claude Code, message:1)', finish: 'Tell the AIs' } }]);
  assert.equal(handed.length, 0);
  assert.deepEqual(result.weighed, [{ record_id: rowId, verdict: 'done', probability: 0.93 }]);
});

test('"how do I do this?" and "remind me later" close nothing and hand nothing on', async () => {
  for (const [text, p] of [['Upload the plugin: how do I do this?', 0.04], ['Upload the plugin, remind me later', 0.08]]) {
    const { io, asked, settled, handed } = world(byWords([[text, p]]));
    const result = await weighSaidDone({ message: message(text), ...io });
    assert.equal(asked.length, 1, text);
    assert.equal(settled.length, 0, text);
    assert.equal(handed.length, 0, text);
    assert.equal(result.weighed[0].verdict, 'not_said', text);
  }
});

test('an AI\'s message naming the row, someone else\'s words, and history brought in are never asked about', async () => {
  const day = 24 * 60 * 60 * 1000;
  for (const words of [
    message('Upload the plugin is done', { speaker: 'ai' }),
    message('Upload the plugin is done', { speaker: 'Someone (voice-2)' }),
    message('Upload the plugin is done', { origin: 'scheduled' }),
    message('Upload the plugin is done', { at: new Date(Date.now() - 3 * day).toISOString(), recorded_at: new Date().toISOString() }),
  ]) {
    const { io, asked, settled, handed } = world(() => 0.99);
    assert.deepEqual(await weighSaidDone({ message: words, ...io }), { weighed: [] });
    assert.equal(asked.length + settled.length + handed.length, 0, JSON.stringify(words));
  }
});

test('no classifier answer, or an unsure one, hands the judgement to the person\'s AIs, once per message and row', async () => {
  for (const [answer, verdict, why] of [[null, 'no_classifier', /did not answer/], [0.5, 'unsure', /was unsure \(0\.50/]]) {
    const { io, settled, handed } = world(() => answer);
    const result = await weighSaidDone({ message: message('Upload the plugin, did it ages ago'), ...io });
    assert.equal(settled.length, 0);
    assert.equal(handed.length, 1);
    const [job] = handed;
    assert.equal(job.priority, saidDoneSettings.hand.priority);
    assert.ok(job.priority >= 6, 'ahead of ordinary work');
    assert.equal(job.once_per, `said-done:message:1:${rowId}`);
    assert.match(job.job, why);
    assert.match(job.job, /put_list_rows on list chores with rows \[\{ "id": "plugin", "values": \{"status":"Done"/);
    assert.match(job.job, /read_messages with conversation_id c-1/);
    assert.equal(job.input.said_done.values.status, 'Done');
    assert.equal(result.weighed[0].verdict, verdict);
    assert.equal(result.weighed[0].handoff_id, 'h_1');
  }
});

test('a row already settled, a link to no list and a list with nothing that settles are left alone', async () => {
  const { io, asked } = world(() => 0.99, { status: 'Done' });
  assert.deepEqual(await weighSaidDone({ message: message('Upload the plugin, done'), ...io }), { weighed: [] });
  assert.equal(asked.length, 0);
  const plain = { ...list, fields: list.fields.map(field => ({ ...field, settles: undefined })) };
  assert.deepEqual(await rowsNamed(message('x'), { read: () => ({ status: 'Waiting' }), listFor: () => plain }), []);
  assert.deepEqual(await rowsNamed(message('x', { about: [{ kind: 'record', id: 'record:other:1' }] }), { read: () => ({}), listFor: () => null }), []);
});

test('a long message is asked about the stretch around the words that name the row, never whole', async () => {
  const long = `${'chatter about the week. '.repeat(200)}Upload the plugin is something I already did last week. ${'more chatter. '.repeat(200)}`;
  const start = long.indexOf('Upload the plugin');
  const { io, asked } = world(() => 0.9);
  await weighSaidDone({ message: message(long, { entity_resolution: { mentions: [{ kind: 'record', id: rowId, list_id: 'chores', start, end: start + 17 }] } }), ...io });
  assert.ok(asked[0].state.length < saidDoneSettings.text_chars + 400);
  assert.match(asked[0].state, /I already did last week/);
});

test('without the broughtIn owner nothing is weighed', async () => {
  const { io, asked } = world(() => 0.99);
  await assert.rejects(weighSaidDone({ message: message('Upload the plugin, done'), ...io, broughtIn: undefined }), /broughtIn/);
  assert.equal(asked.length, 0);
});

test('only the person\'s own words count', () => {
  assert.equal(thePersonsWords(message('x')), true);
  assert.equal(thePersonsWords(message('x', { speaker: 'ai' })), false);
  assert.equal(thePersonsWords(message('x', { origin: 'scheduled' })), false);
});
