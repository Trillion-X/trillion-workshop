// Meeting notes made on this Mac from one moment (computer/meeting-notes.mjs, DATA in computer-sources.json listen.notes):
// only kept lines are shown, every note item names lines it stands on, and unsupported items are counted, not kept.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decide, rowOf, speakerOf } from '../listen.mjs';
import { meetingNotes, notesFrom, shownLines } from '../meeting-notes.mjs';

const settings = rowOf(JSON.parse(readFileSync(new URL(import.meta.resolve('../../bring-in-new-items-from-this-computer/computer/computer-sources.json')), 'utf8'))).listen;
const say = (text, name, index) => ({ text, speaker: speakerOf({ who: name ? { name } : null, voice: 'voice-2' }, settings.words), source_id: `m#${index}`, who: name ? { name } : null });
const lines = [
  say('We should ship the new listening build on Friday if the tests pass.', 'Ana', 1),
  say('Fine, I will run the full test suite tonight and send you the results.', 'Ben', 2),
  say('This part is off the record, the acquisition price is confidential.', 'Ana', 3),
  say('Okay and someone needs to tell the design team about the delay before then.', null, 4),
];
const keeps = line => decide(settings.rules, line).keep;

test('a model cannot replace the retained source identities with its own string', () => {
  const made = notesFrom({ summary: [{ text: 'A generated note', from: [1], sources: 'invented-source' }] }, settings.notes, shownLines(lines, keeps));
  assert.deepEqual(made.fields.summary[0].sources, ['m#1']);
});
const reply = content => ({ choices: [{ message: { content: JSON.stringify(content) } }], model: 'fake' });

test('notes show only kept lines, keep supported items with their source ids, and count the unsupported', async () => {
  const seen = [];
  const made = await meetingNotes({ lines, keeps, notes: settings.notes, log: () => {}, ask: async input => {
    seen.push(input);
    return reply({
      summary: [{ text: 'Ship Friday if tests pass', from: [1] }],
      decisions: [{ text: 'Invented decision', from: [99] }, { text: 'No line at all' }],
      actions: [{ text: 'Run the test suite tonight', from: [2, 77], owner: 'Ben' }, { text: 'Tell the design team', from: [3] }],
    });
  } });
  const prompt = seen[0].messages.map(message => message.content).join('\n');
  assert.equal(seen[0].job, settings.notes.job);
  assert.ok(!prompt.includes('acquisition price'), 'a line the keep rules leave out is never shown to the model');
  assert.deepEqual(shownLines(lines, keeps).map(line => line.n), [1, 2, 3]);
  assert.equal(made.kind, 'notes');
  assert.deepEqual(made.value.fields.summary, [{ text: 'Ship Friday if tests pass', from: [1], sources: ['m#1'] }]);
  assert.deepEqual(made.value.fields.decisions, []);
  assert.deepEqual(made.value.fields.actions.map(item => [item.text, item.from, item.sources, item.owner ?? null]), [['Run the test suite tonight', [2], ['m#2'], 'Ben'], ['Tell the design team', [3], ['m#4'], null]]);
  assert.equal(made.value.unsupported, 2);
});

test('no notes when off, too little was said, no model answered, or the answer is not JSON', async () => {
  const ask = async () => reply({});
  assert.equal(await meetingNotes({ lines, keeps, notes: { ...settings.notes, on: false }, ask }), null);
  assert.equal(await meetingNotes({ lines: lines.slice(0, 1), keeps, notes: { ...settings.notes, min_words: 40 }, ask }), null);
  const logs = [];
  assert.equal(await meetingNotes({ lines, keeps, notes: settings.notes, log: line => logs.push(line), ask: async () => ({ error: 'none here' }) }), null);
  assert.match(logs[0], /none here/);
  assert.equal(await meetingNotes({ lines, keeps, notes: settings.notes, log: line => logs.push(line), ask: async () => ({ choices: [{ message: { content: 'sure!' } }] }) }), null);
  assert.equal(logs[1], settings.notes.words.not_json);
});

// ---- Templates and the end-of-meeting question (invariants 5 and 6) -------------------------------------------------
import { meetingEnded, templateFields } from '../meeting-notes.mjs';

const long = Array.from({ length: 8 }, (_, index) => say(`Line number ${index} of a long enough conversation about the plan and who does what by when.`, index % 2 ? 'Ben' : 'Ana', index + 10));

test('a template is DATA: its sections become the fields asked for, and the heading cap grows with what was said', () => {
  const asked = templateFields(settings.notes, 'customer-call', 100);
  assert.deepEqual(asked.fields.map(field => field.id), ['needs', 'objections', 'next-steps']);
  assert.equal(asked.template, 'customer-call');
  const capped = templateFields({ ...settings.notes, heading_cap: { base: 1, per_words: 100, most: 12 } }, 'customer-call', 150);
  assert.deepEqual(capped.fields.map(field => field.id), ['needs', 'objections']);
  assert.equal(capped.dropped, 1);
  assert.deepEqual(templateFields(settings.notes, 'general', 0).fields, settings.notes.fields);
  assert.equal(templateFields(settings.notes, 'no-such-template', 0), null);
});

test('notes under a template ask for its sections, name it in the result, and an unknown template makes none', async () => {
  const seen = []; const said = [];
  const made = await meetingNotes({ lines: long, template: 'one-on-one', notes: settings.notes, log: line => said.push(line), ask: async input => {
    seen.push(input);
    return input.max_tokens === settings.notes.ended.max_tokens ? { choices: [{ message: { content: JSON.stringify({ answer: 'Ended' }) } }] } : reply({ topics: [{ text: 'The plan', from: [1] }], feedback: [], actions: [] });
  } });
  const prompt = seen[0].messages.map(message => message.content).join('\n');
  assert.match(prompt, /"topics" \(a list/);
  assert.ok(!prompt.includes('"follow-ups"'), 'a short conversation is not asked for the fourth heading (heading_cap)');
  assert.ok(!prompt.includes('"decisions"'));
  assert.equal(made.value.template, 'one-on-one');
  assert.deepEqual(Object.keys(made.value.fields), ['topics', 'feedback', 'actions']);
  assert.equal(made.value.dropped_sections, 1);
  assert.equal(made.value.ended, true);
  assert.equal(await meetingNotes({ lines: long, template: 'nope', notes: settings.notes, log: line => said.push(line), ask: async () => reply({}) }), null);
  assert.match(said.at(-1), /no notes template nope/);
  console.log('REAL readback of a templated note result:', JSON.stringify(made.value));
});

test('whether the meeting ended is a two-word question about the last words: unknown stays null and never withholds the notes', async () => {
  const asks = [];
  const answerWith = content => async input => { asks.push(input); return { choices: [{ message: { content: JSON.stringify({ answer: content }) } }] }; };
  assert.equal(await meetingEnded({ lines: long, ended: settings.notes.ended, ask: answerWith('ended') }), true);
  assert.equal(await meetingEnded({ lines: long, ended: settings.notes.ended, ask: answerWith('Continuing') }), false);
  assert.equal(await meetingEnded({ lines: long, ended: settings.notes.ended, ask: answerWith('maybe') }), null);
  assert.equal(await meetingEnded({ lines: long.slice(0, 1), ended: settings.notes.ended, ask: answerWith('ended') }), null, 'too little said to judge');
  assert.equal(await meetingEnded({ lines: long, ended: { ...settings.notes.ended, on: false }, ask: answerWith('ended') }), null);
  assert.equal(asks[0].max_tokens, settings.notes.ended.max_tokens);
  assert.equal(await meetingEnded({ lines: long, ended: settings.notes.ended, ask: async () => ({ choices: [{ message: { content: 'ended' } }] }) }), null, 'an answer that is not the JSON object is unknown');
  assert.ok(asks[0].messages[1].content.split('Did the people')[0].split(/\s+/).length < 130, 'only the last words are shown');
  const made = await meetingNotes({ lines: long, notes: settings.notes, ask: async input => (input.max_tokens === settings.notes.ended.max_tokens ? { error: 'down' } : reply({ summary: [{ text: 'x', from: [1] }] })) });
  assert.equal(made.value.ended, null);
  assert.equal(made.value.fields.summary.length, 1, 'the notes are still made when the ended question gets no answer');
});

test('action items in the notes become task proposals for the person to review, with only a said date, and nothing is proposed when it is off or there are none', async () => {
  const { taskProposalsFrom } = await import('../meeting-notes.mjs');
  const notes = { propose_tasks: { on: true, fields: ['actions', 'action-items'], most: 2, proposed_by: 'Listening notes' } };
  const made = { value: { fields: { summary: [{ text: 'We met.' }], actions: [{ text: 'Send the deck', owner: 'Ana', due: '2026-10-23', from: [1] }, { text: 'Book the room', due: 'Friday', from: [2] }], 'action-items': [{ text: 'Third one', from: [3] }] } } };
  assert.deepEqual(taskProposalsFrom(made, notes, 'moment-1'), { source_id: 'moment-1', proposed_by: 'Listening notes', items: [{ title: 'Send the deck', due: '2026-10-23', evidence: 'Ana: Send the deck' }, { title: 'Book the room' }] });
  assert.equal(taskProposalsFrom(made, { propose_tasks: { ...notes.propose_tasks, on: false } }, 'm'), null);
  assert.equal(taskProposalsFrom({ value: { fields: { actions: [] } } }, notes, 'm'), null);
  assert.equal(taskProposalsFrom(null, notes, 'm'), null);
});
