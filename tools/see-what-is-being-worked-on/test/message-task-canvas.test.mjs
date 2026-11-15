import test from 'node:test';
import assert from 'node:assert/strict';
import { messageTaskGraph, mergeMessagePage, messageSourceSpan } from 'trillion-workshop/tools/see-what-is-being-worked-on/message-task-canvas.mjs';

const source = { id: 'message:one', app: 'Codex', conversation_id: 'chat-1', speaker: 'person', text: 'Make a useful thing', at: '2026-09-29T10:00:00Z' };
const arrival = { id: 'arrival:one', message_id: source.id, job: source.text, route: 'Codex', at: source.at };
const empty = { messages: [], arrivals: [], activity: [], handoffs: [] };

test('owner IDs connect source, arrival and each recorded AI contribution without duplicating prefixes', () => {
  const graph = messageTaskGraph({ ...empty, messages: [source], arrivals: [arrival], activity: [
    { seq: 1, app: 'Codex', label: 'Wrote a file', item: 'file:one', for: [arrival.id], at: source.at, ok: true },
    { seq: 2, app: 'Codex', label: 'Could not run a tool', for: [arrival.id], at: source.at, ok: false },
  ] });
  assert.ok(graph.edges.some(edge => edge.from === source.id && edge.to === arrival.id));
  assert.ok(graph.edges.some(edge => edge.from === arrival.id && edge.to === 'activity:1'));
  assert.equal(graph.nodes.filter(node => node.kind === 'AI contribution').length, 2);
  assert.equal(graph.nodes.find(node => node.id === 'activity:1').status, undefined, 'a successful call is not a completed task');
  assert.equal(graph.nodes.find(node => node.id === 'activity:2').status, 'failed');
  assert.ok(graph.edges.every(edge => graph.nodes.some(node => node.id === edge.from) && graph.nodes.some(node => node.id === edge.to)));
});

test('two apps using the same conversation ID stay separate', () => {
  const other = { ...source, id: 'message:two', app: 'Claude' };
  const graph = messageTaskGraph({ ...empty, messages: [source, other,
    { ...source, id: 'reply:one', speaker: 'ai', text: 'Codex answer' },
    { ...other, id: 'reply:two', speaker: 'ai', text: 'Claude answer' },
  ] });
  const chats = graph.nodes.filter(node => node.kind === 'AI chat');
  assert.equal(chats.length, 2);
  assert.notEqual(graph.edges.find(edge => edge.from === source.id).to, graph.edges.find(edge => edge.from === other.id).to);
});

test('real handoff parents and source references form tasks and subtasks, with their recorded state', () => {
  const graph = messageTaskGraph({ ...empty, messages: [source], handoffs: [
    { handoff_id: 'handoff:parent', job: 'Make a useful thing', input: { arrived: { message_id: source.id } }, state: 'taken', handed_at: source.at },
    { handoff_id: 'handoff:child', parent_handoff_id: 'handoff:parent', job: 'Check the thing', state: 'finished', result: 'The check passed', finished_at: source.at },
  ] });
  assert.ok(graph.edges.some(edge => edge.from === source.id && edge.to === 'handoff:parent'));
  assert.ok(graph.edges.some(edge => edge.from === 'handoff:parent' && edge.to === 'handoff:child'));
  assert.equal(graph.nodes.find(node => node.id === 'handoff:child').kind, 'Subtask');
  assert.match(graph.nodes.find(node => node.id === 'handoff:child').body, /The check passed/);
});

test('paging retains prior links and replaces repeated records with the current read', () => {
  const merged = mergeMessagePage({ ...empty, messages: [source], arrivals: [arrival], handoffs: [{ handoff_id: 'handoff:one', state: 'taken' }] },
    { ...empty, messages: [source, { ...source, id: 'message:older' }], handoffs: [{ handoff_id: 'handoff:one', state: 'finished' }], next_before: null });
  assert.equal(merged.messages.length, 2);
  assert.equal(merged.arrivals.length, 1);
  assert.equal(merged.handoffs[0].state, 'finished');
  assert.equal(merged.next_before, null);
});

test('source spans are bounded by the stored person message and preserve its exact words', () => {
  const span = messageSourceSpan(source, { start: 7, end: source.text.length });
  assert.equal(span.text, 'useful thing');
  assert.throws(() => messageSourceSpan(source, { start: -1, end: 5 }), /Choose words/);
  assert.throws(() => messageSourceSpan(source, { start: 0, end: source.text.length + 1 }), /Choose words/);
  assert.throws(() => messageSourceSpan({ ...source, speaker: 'ai' }, { start: 0, end: 4 }), /own messages/);
  const graph = messageTaskGraph({ ...empty, messages: [source], handoffs: [{
    handoff_id: 'handoff:span', job: span.text, input: { source_span: span, arrived: { message_id: source.id } }, state: 'waiting', handed_at: source.at,
  }] });
  assert.equal(graph.nodes.find(node => node.id === source.id).source_spans[0].task_id, 'handoff:span');
  assert.equal(graph.nodes.find(node => node.id === 'handoff:span').source_message, source.text);
});

test('linked decisions and pursuits use their current records without adding unrelated records', () => {
  const graph = messageTaskGraph({ ...empty, messages: [{ ...source, about: [{ id: 'case:one', kind: 'decision' }] }], related: [
    { id: 'case:one', kind: 'Decision', label: 'Choose useful work', body: 'Make the change', at: source.at, app: '', about: [{ id: 'pursuit:one' }] },
    { id: 'pursuit:one', kind: 'Pursuit', label: 'Build useful software', body: 'People can act on their work', at: source.at, app: '' },
    { id: 'pursuit:unrelated', kind: 'Pursuit', label: 'Unrelated', body: '', at: source.at, app: '' },
  ] });
  assert.ok(graph.edges.some(edge => edge.from === source.id && edge.to === 'case:one'));
  assert.ok(graph.edges.some(edge => edge.from === 'case:one' && edge.to === 'pursuit:one'));
  assert.ok(!graph.nodes.some(node => node.id === 'pursuit:unrelated'));
});

test('source attachments and repeated output references keep one openable file node', () => {
  const opens = { surface: 'trillion.file', input: 'id' };
  const graph = messageTaskGraph({ ...empty, messages: [{ ...source, about: [{ kind: 'file', id: 'file:output' }] }], arrivals: [{ ...arrival, files: [{ id: 'file:voice', name: 'Original memo.m4a' }] }], activity: [
    { seq: 1, app: 'Codex', for: [arrival.id], item: 'file:voice', title: 'Original memo.m4a', opens, at: source.at },
    { seq: 2, app: 'Codex', for: [arrival.id], item: 'file:output', title: 'Edited clip.mp4', opens, at: source.at },
  ] });
  assert.ok(graph.edges.some(edge => edge.from === source.id && edge.to === 'file:voice'));
  assert.equal(graph.nodes.filter(node => node.id === 'file:voice').length, 1);
  assert.deepEqual(graph.nodes.find(node => node.id === 'file:voice').opens, opens);
  assert.deepEqual(graph.nodes.find(node => node.id === 'file:output').opens, opens);
  assert.equal(graph.nodes.find(node => node.id === 'file:output').label, 'Edited clip.mp4');
});

test('a follow-up connects its source to the actual handed-off job', () => {
  const asked = { id: 'asked:one', job: 'Review this source', context: { source_id: source.id, words: 'Review the second paragraph.\nKeep the answer brief.' }, at: source.at };
  const graph = messageTaskGraph({ ...empty, messages: [source], asked: [asked], handoffs: [
    { handoff_id: 'handoff:follow-up', job: asked.job, input: { arrived: { asked_id: asked.id } }, state: 'open', handed_at: source.at },
  ] });
  assert.equal(graph.nodes.find(node => node.id === asked.id).body, asked.context.words);
  assert.ok(graph.edges.some(edge => edge.from === source.id && edge.to === asked.id));
  assert.ok(graph.edges.some(edge => edge.from === asked.id && edge.to === 'handoff:follow-up'));
  const merged = mergeMessagePage({ ...empty, asked: [asked] }, { ...empty, asked: [] });
  assert.deepEqual(merged.asked, [asked]);
});

test('blocks connect source records and nested sub-blocks', () => {
  const second = { ...source, id: 'message:two', text: 'Another useful request' };
  const graph = messageTaskGraph({ ...empty, messages: [source, second], blocks: [
    { id: 'block:one', source_id: source.id, title: 'Launch checklist', state: 'in_progress', progress: 40, start: 7, end: 13, sources: [{ source_id: second.id, start: 8, end: 14 }], proof: [{ kind: 'handoff', id: 'handoff:proof' }] },
    { id: 'block:child', source_id: source.id, parent_id: 'block:one', title: 'Check wording', state: 'done' },
  ], handoffs: [{ handoff_id: 'handoff:proof', job: 'Check the list', state: 'finished' }] });
  assert.ok(graph.edges.some(edge => edge.from === source.id && edge.to === 'block:one'));
  assert.ok(graph.edges.some(edge => edge.from === second.id && edge.to === 'block:one'));
  assert.ok(graph.edges.some(edge => edge.from === 'block:one' && edge.to === 'block:child'));
  assert.ok(graph.edges.some(edge => edge.from === 'block:one' && edge.to === 'handoff:proof'));
  assert.equal(graph.nodes.find(node => node.id === 'block:one').progress, 40);
  assert.equal(graph.nodes.find(node => node.id === source.id).source_spans[0].text, 'useful');
  assert.equal(graph.nodes.find(node => node.id === second.id).source_spans[0].text, 'useful');
  assert.equal(graph.nodes.find(node => node.id === 'block:child').kind, 'Block');
});

test('words written on an item hang off it, with the work they start', () => {
  const file = { id: 'file:note', kind: 'file' };
  const source = { id: 'message:source', speaker: 'person', text: 'Please review the note.', app: 'Trillion', at: '2026-10-03T10:00:00.000Z', about: [file] };
  const comment = { id: 'message:comment', speaker: 'person', text: '@Writer summarize it.', app: 'Trillion', at: '2026-10-03T10:05:00.000Z', about: [{ kind: 'record', id: file.id }, { kind: 'agent', id: 'w' }] };
  const graph = messageTaskGraph({ messages: [source, comment], arrivals: [], activity: [], handoffs: [{ handoff_id: 'handoff:comment', job: comment.text, input: { arrived: { message_id: comment.id } }, state: 'open', handed_at: comment.at }] });
  assert.ok(graph.edges.some(edge => edge.from === file.id && edge.to === comment.id), 'the item points at the words written on it');
  assert.ok(!graph.edges.some(edge => edge.from === comment.id && edge.to === file.id), 'never the other way round');
  assert.ok(graph.edges.some(edge => edge.from === comment.id && edge.to === 'handoff:comment'), 'the words lead to the work they start');
});
