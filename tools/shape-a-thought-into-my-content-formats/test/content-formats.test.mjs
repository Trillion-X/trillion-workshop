// Old trillion's test/content-formats.test.mjs (tag old-trillion-before-worker-retire), ported: the owner is the same
// makeContentFormats and handleContentFormatsRequest (read-data/content-formats.mjs). The one assertion left out named
// the old route table's family (src/native-owner-routes.mjs ownerRouteFamily); the route row's own test
// (answer-the-content-formats-page.test.mjs) checks the page reaches this owner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleContentFormatsRequest, makeContentFormats } from '../read-data/content-formats.mjs';
import starters from '../data/content-format-starters.json' with { type: 'json' };

const memory = () => { let saved = null; return { saved: () => saved, putSaved: list => { saved = structuredClone(list); } }; };

test('an account that saved none reads every starter, each with its parts in order', () => {
  const { formats } = makeContentFormats({ store: memory() }).read();
  const expected = starters.formats.length + starters.writing_library.frameworks.length + starters.writing_library.templates.length;
  assert.equal(formats.length, expected);
  assert.ok(formats.every(row => row.from === 'starter' && row.slots.length > 0 && row.slots.every(slot => slot.id && slot.label)));
  const short = formats.find(row => row.id === 'short_video_script');
  assert.deepEqual(short.slots.map(slot => slot.label), ['Hook', 'Beats', 'Call to action']);
  assert.equal(formats.find(row => row.id === 'aida').category, 'Persuasion');
});

test('saved formats come first, and one with a starter id replaces that starter', () => {
  const owner = makeContentFormats({ store: memory() });
  const { formats } = owner.save({ formats: [
    { label: 'Court-side lesson', slots: [{ label: 'The mistake' }, { label: 'The fix', hint: 'Show it once.' }] },
    { id: 'x_thread', label: 'My X thread', spec: 'Short posts, no hooks.' },
  ] });
  assert.equal(formats[0].id, 'court_side_lesson');
  assert.deepEqual(formats[0].slots.map(slot => slot.id), ['the_mistake', 'the_fix']);
  assert.equal(formats[1].label, 'My X thread');
  assert.equal(formats[1].from, 'saved');
  assert.equal(formats.filter(row => row.id === 'x_thread').length, 1);
});

test('a starter the person removes stays out of their list until they put it back, and their own formats stay', () => {
  const store = memory();
  const owner = makeContentFormats({ store });
  const { formats } = owner.save({ formats: [{ label: 'Kept', spec: 'Say it plainly.' }, { id: 'x_thread', removed: true }] });
  assert.ok(!formats.some(row => row.id === 'x_thread'), 'the removed starter is not in their list');
  assert.ok(formats.some(row => row.id === 'kept') && formats.some(row => row.id === 'blog'), 'their own and the other starters stay');
  assert.deepEqual(owner.read().removed_starters.map(row => row.id), ['x_thread'], 'and it stays out on every read');
  assert.throws(() => owner.save({ formats: [{ id: 'not_a_starter', removed: true }] }), /id of a starter format/);
  owner.save({ formats: owner.read().formats.filter(row => row.from === 'saved') });
  assert.ok(!owner.read().formats.some(row => row.id === 'x_thread'), 'sending back what was read keeps it out');
  owner.save({ formats: [{ label: 'Kept', spec: 'Say it plainly.' }, { id: 'x_thread', removed: false }] });
  assert.ok(owner.read().formats.some(row => row.id === 'x_thread'), 'removed: false puts the starter back');
  assert.deepEqual(owner.read().removed_starters, []);
});

test('a refused save leaves the saved list as it was', async () => {
  const store = memory();
  const owner = makeContentFormats({ store });
  owner.save({ formats: [{ label: 'Kept', spec: 'Say it plainly.' }] });
  const answer = await handleContentFormatsRequest(owner, new Request('https://person/content-formats', { method: 'POST', body: JSON.stringify({ formats: [{ label: 'Kept', spec: 'x' }, { label: 'No shape' }] }) }));
  assert.equal(answer.status, 400);
  assert.match((await answer.json()).error, /No shape: say how it goes/);
  assert.deepEqual(store.saved().map(row => row.label), ['Kept']);
  const read = await handleContentFormatsRequest(owner, new Request('https://person/content-formats'));
  assert.equal((await read.json()).formats[0].label, 'Kept');
});

test('every starter format says its input, its steps and its output, and the list says where examples come from', () => {
  const { formats, example_kinds } = makeContentFormats({ store: memory() }).read();
  const made = formats.filter(row => starters.formats.some(format => format.id === row.id));
  assert.equal(made.length, starters.formats.length);
  assert.ok(made.every(row => row.input && row.process.length > 0 && row.output));
  assert.ok(['article', 'substack', 'short_video_script', 'newsletter', 'x_thread'].every(id => made.some(row => row.id === id)));
  assert.deepEqual(example_kinds.map(kind => kind.id), ['own', 'customer', 'famous']);
  assert.ok(!JSON.stringify(starters).includes('—'));
});

test('a saved format keeps its input, steps and output, and a step with no words is refused', () => {
  const owner = makeContentFormats({ store: memory() });
  const { formats } = owner.save({ formats: [{ label: 'Walk note', input: 'A voice note', process: ['Pick the idea', 'Write it'], output: 'A post', spec: 'Say it plainly.' }] });
  assert.deepEqual([formats[0].input, formats[0].process, formats[0].output], ['A voice note', ['Pick the idea', 'Write it'], 'A post']);
  assert.throws(() => owner.save({ formats: [{ label: 'Broken', spec: 'x', process: ['Fine', ' '] }] }), /each process step says what to do/);
});

test('source choices list the account material newest first and shape a selected source into the named format', async () => {
  const readers = {
    files: {
      list: async kind => kind.id === 'recording'
        ? [{ id: 'recording-1', title: 'New recording', at: '2026-10-01T12:00:00Z' }, { id: 'recording-2', title: 'Old recording', at: '2026-09-30T12:00:00Z' }]
        : [{ id: 'note-1', title: 'A note', at: '2026-10-01T13:00:00Z' }],
      words: async (kind, id) => ({ title: id === 'note-1' ? 'A note' : 'New recording', words: id === 'note-1' ? 'Notes begin here.' : 'I learned this today. It changed how I work.' }),
    },
    pursuits: { list: async () => [], words: async () => null },
  };
  const owner = makeContentFormats({ store: memory(), readers });
  const choices = await owner.sources();
  assert.deepEqual(choices.sources.map(row => row.id), ['note-1', 'recording-1', 'recording-2']);
  assert.ok(choices.sources.every(({ kind, label, id, title, at }) => kind && label && id && title && at));

  const shaped = await owner.shape({ source: { kind: 'recording', id: 'recording-1' }, format_ids: ['x_thread'] });
  assert.deepEqual(shaped.source, { kind: 'recording', label: 'recording', id: 'recording-1', title: 'New recording' });
  assert.equal(shaped.material, 'I learned this today.\nIt changed how I work.');
  assert.equal(shaped.scripts.length, 1);
  assert.equal(shaped.scripts[0].lines[0].words, 'I learned this today.');
  assert.equal(shaped.scripts[0].lines[1].words, 'It changed how I work.');
  assert.equal(shaped.scripts[0].lines[0].theirs, true);
  // No workflow is named by the product: the way to the finished piece is found for the job, or is the account's own.
  assert.equal(shaped.before_writing.next_call.tool, 'find_workflow');
  assert.equal(shaped.before_writing.next_call.arguments.job, shaped.before_writing.job);
  assert.match(shaped.before_writing.job, /finished piece/);
  await owner.save({ formats: [{ id: 'x_thread', label: 'Thread', spec: 'Short lines.', workflow_id: 'workflow:fixture-finish-a-piece' }] });
  const own = await owner.shape({ source: { kind: 'recording', id: 'recording-1' }, format_ids: ['x_thread'] });
  assert.deepEqual(own.before_writing, { workflows: [{ workflow_id: 'workflow:fixture-finish-a-piece', next_call: { tool: 'start_workflow', arguments: { workflow_id: 'workflow:fixture-finish-a-piece' } } }] });
});

test('shape defaults to the newest source only when no thought or source is supplied, and refuses a source outside the account', async () => {
  const readers = {
    files: { list: async () => [{ id: 'note-1', title: 'A note', at: '2026-10-01T13:00:00Z' }], words: async (_kind, id) => id === 'note-1' ? { title: 'A note', words: 'One useful sentence.' } : null },
    pursuits: { list: async () => [], words: async () => null },
  };
  const owner = makeContentFormats({ store: memory(), readers });
  const newest = await owner.shape({ format_ids: ['x_thread'] });
  assert.equal(newest.source.id, 'note-1');
  assert.match(newest.material, /One useful sentence/);
  assert.equal((await owner.shape({ thought: 'My own thought.', format_ids: ['x_thread'] })).source, null);
  await assert.rejects(owner.shape({ source: { kind: 'note', id: 'private-other-person' } }), /not in this account/);
  await assert.rejects(makeContentFormats({ store: memory() }).shape({}), /no recording, note or pursuit/);
});

test('the sources and shape routes reach the same source backed format decision', async () => {
  const owner = makeContentFormats({
    store: memory(),
    readers: {
      files: { list: async () => [{ id: 'note-1', title: 'A note', at: '2026-10-01T13:00:00Z' }], words: async () => ({ title: 'A note', words: 'A sentence from the note.' }) },
      pursuits: { list: async () => [], words: async () => null },
    },
  });
  const sources = await handleContentFormatsRequest(owner, new Request('https://person/content-formats/sources'));
  assert.equal(sources.status, 200);
  assert.equal((await sources.json()).sources[0].id, 'note-1');
  const shaped = await handleContentFormatsRequest(owner, new Request('https://person/content-formats/shape', { method: 'POST', body: JSON.stringify({ source: { kind: 'note', id: 'note-1' }, format_ids: ['x_thread'] }) }));
  assert.equal(shaped.status, 200);
  assert.match((await shaped.json()).material, /A sentence from the note/);
  assert.equal((await handleContentFormatsRequest(owner, new Request('https://person/content-formats/unknown'))).status, 404);
  assert.equal((await handleContentFormatsRequest(owner, new Request('https://person/content-formats/sources', { method: 'POST', body: '{}' }))).status, 404);
});

test('a format can name the caption style its videos use, and only one the caption styles hold', () => {
  const owner = makeContentFormats({ store: memory() });
  const { formats } = owner.save({ formats: [{ id: 'my_short_reel', label: 'My short reel', spec: 'A reel in my voice.', caption_style: 'white-words-light-up' }] });
  assert.equal(formats.find(format => format.id === 'my_short_reel').caption_style, 'white-words-light-up');
  assert.throws(() => owner.save({ formats: [{ label: 'Loud reel', spec: 'x', caption_style: 'yellow-bounce' }] }), /caption_style is one of the caption styles: .*white-words-light-up/);
});
