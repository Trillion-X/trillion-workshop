import assert from 'node:assert/strict';
import test from 'node:test';
import { MOST_PER_PAGE, publicListing, publicToolCatalog } from '../src/public-tool-catalog.mjs';
import { admitToolDescriptor } from '../../ai-tool-catalog/read-data/read-ai-tool-catalog.ts';

test('descriptor admission preserves only a boolean website display choice', () => {
  const row = { kind: 'ai-tool-descriptor', id: 'tool:example', label: 'Example', job: 'Do a job', show_on_public_site: true };
  assert.equal(admitToolDescriptor(row).item.show_on_public_site, true);
  assert.deepEqual(admitToolDescriptor({ ...row, public_run: { runs_per_day: 10, max_input_bytes: 2048 } }).item.public_run, { runs_per_day: 10, max_input_bytes: 2048 });
  for (const public_run of [{ runs_per_day: 0 }, { runs_per_day: 101 }, { runs_per_day: 5, max_input_bytes: 16_385 }, { runs_per_day: 5, other: true }]) {
    assert.match(admitToolDescriptor({ ...row, public_run }).refused.reason, /public_run/);
  }
  assert.match(admitToolDescriptor({ ...row, show_on_public_site: 'true' }).refused.reason, /true or false/);
});

test('anonymous catalog lists Trillion\'s own shared rows and opted-in maker tools, display words only', () => {
  const published = [
    { maker: 'private-person', row: { label: 'Private editor', job: 'Edit a private video', invoke: { secret_name: 'private-key' } } },
    { maker: 'public-maker-id', row: { label: 'Caption a video', job: 'Write captions for a video', show_on_public_site: true, invoke: { secret_name: 'held-key' }, input_schema: { private: true }, runs: [{ person: 'someone' }] } },
    { maker: 'public-maker-id', row: { label: 'Transcribe audio', job: 'Turn speech into text', show_on_public_site: true } },
  ];
  const shared = {
    tools: [{ id: 'tool:speech-to-text', kind: 'tool', label: 'Speech to text', job: 'Transcribe speech in a recording into text' }],
    workflows: [{ id: 'workflow:plan-a-launch', kind: 'workflow', label: 'Plan a launch', job: 'Plan a product launch step by step', steps: ['Scope'] }],
  };
  const result = publicToolCatalog({ published }, { q: 'caption', offset: 0, limit: 20 });
  assert.deepEqual(result, { items: [{ kind: 'tool', title: 'Caption a video', job: 'Write captions for a video', from: 'maker' }], total: 1, offset: 0, limit: 20 });
  assert.doesNotMatch(JSON.stringify(result), /private-person|public-maker-id|secret_name|input_schema|runs|private-key|held-key/);
  const all = publicToolCatalog({ shared, published });
  assert.deepEqual(all.items.map(item => item.title), ['Plan a launch', 'Speech to text', 'Caption a video', 'Transcribe audio'], 'the in-app shared rows come first, then makers\' public tools');
  assert.equal(all.items[0].id, 'workflow:plan-a-launch');
  assert.deepEqual(publicToolCatalog({ shared, published }, { kind: 'workflow' }).items.map(item => item.id), ['workflow:plan-a-launch']);
  assert.deepEqual(publicToolCatalog({ shared, published }, { q: 'text' }).items.map(item => item.title), ['Speech to text', 'Transcribe audio']);
  assert.deepEqual(publicToolCatalog({ shared, published }, { q: 'speech  TEXT' }).items.map(item => item.title), ['Speech to text', 'Transcribe audio'], 'every word, in any order; title matches first');
  assert.deepEqual(publicToolCatalog({ shared, published }, { q: 'text launch' }).items, []);
  assert.deepEqual(publicToolCatalog({ published }, { offset: 1, limit: 1 }).items, [{ kind: 'tool', title: 'Transcribe audio', job: 'Turn speech into text', from: 'maker' }]);
  const featured = publicToolCatalog({ shared, published }, { ids: ['tool:speech-to-text', 'workflow:missing', 'workflow:plan-a-launch'] });
  assert.deepEqual(featured.items.map(item => item.id), ['tool:speech-to-text', 'workflow:plan-a-launch'], 'named listings only, in the order named; makers\' tools have no id to name');
  assert.equal(featured.total, 2);
});

test('one page carries up to the whole Marketplace, never more than its bound', () => {
  const shared = { workflows: [], tools: Array.from({ length: MOST_PER_PAGE + 5 }, (_, n) => ({ id: `tool:t${n}`, kind: 'tool', label: `Tool ${n}`, job: 'A job' })) };
  const page = publicToolCatalog({ shared }, { limit: 5000 });
  assert.equal(page.limit, MOST_PER_PAGE);
  assert.equal(page.items.length, MOST_PER_PAGE);
  assert.equal(page.total, MOST_PER_PAGE + 5);
});

test('Trillion\'s own cards carry their icon, recording cover and step count; a maker\'s carry none', () => {
  const shared = {
    tools: [{ id: 'tool:speech-to-text', kind: 'tool', label: 'Speech to text', job: 'Transcribe speech', icon: 'AudioLines', recording: { video: 'https://app.example/v.mp4', cover: 'https://app.example/c.webp' } }],
    workflows: [{ id: 'workflow:plan-a-launch', kind: 'workflow', label: 'Plan a launch', job: 'Plan a launch', steps: ['Scope', 'Ship'], recording: { cover: 'javascript:alert(1)' } }],
  };
  const { items } = publicToolCatalog({ shared, published: [{ row: { label: 'Caption', job: 'Captions', show_on_public_site: true, icon: 'X' } }] });
  assert.deepEqual(items[0], { id: 'workflow:plan-a-launch', kind: 'workflow', title: 'Plan a launch', job: 'Plan a launch', from: 'trillion', steps: 2 });
  assert.deepEqual(items[1], { id: 'tool:speech-to-text', kind: 'tool', title: 'Speech to text', job: 'Transcribe speech', from: 'trillion', icon: 'AudioLines', cover: 'https://app.example/c.webp' });
  assert.deepEqual(items[2], { kind: 'tool', title: 'Caption', job: 'Captions', from: 'maker' });
});

test('a listing page only offers actions its descriptor supports and never exposes invocation details', () => {
  const tool = publicListing({
    id: 'tool:speech-to-text', kind: 'tool', label: 'Speech to text', job: 'Transcribe speech', description: 'Turns spoken audio into text.',
    input_schema: { type: 'object', required: ['audio_url'], properties: { audio_url: { type: 'string', format: 'uri', description: 'Where the audio is' }, language: { type: 'string', enum: ['en', 'fr'] } } },
    runnable: true,
    invoke: { kind: 'model', secret_name: 'held' }, recording: { video: 'https://app.example/v.mp4', cover: 'https://app.example/c.webp', title: 'Speech to text' },
  });
  assert.deepEqual(tool.inputs, [
    { name: 'audio_url', kind: 'web address', says: 'Where the audio is', needed: true },
    { name: 'language', kind: 'one of', says: '', needed: false, choices: ['en', 'fr'] },
  ]);
  assert.equal(tool.about, 'Turns spoken audio into text.');
  assert.deepEqual(tool.call, { tool: 'run_tool', arguments: { tool_id: 'tool:speech-to-text' } });
  assert.deepEqual(tool.recording, { video: 'https://app.example/v.mp4', cover: 'https://app.example/c.webp', title: 'Speech to text' });
  assert.doesNotMatch(JSON.stringify(tool), /invoke|secret_name|held/);
  const workflow = publicListing({ id: 'workflow:plan-a-launch', kind: 'workflow', label: 'Plan a launch', job: 'Plan a launch', steps: ['Scope', 'Ship'], recording: null });
  assert.deepEqual([workflow.steps, workflow.inputs, workflow.call], [['Scope', 'Ship'], [], { tool: 'start_workflow', arguments: { workflow_id: 'workflow:plan-a-launch' } }]);
  const screen = publicListing({
    id: 'tool:screen-example', kind: 'tool', label: 'Example screen', job: 'Open the example screen',
    screen: { route_paths: ['/always-recording', '//elsewhere', 'javascript:alert(1)'] },
  });
  assert.deepEqual(screen.open, { route_paths: ['/always-recording'] });
  assert.equal('call' in screen, false, 'a screen without invocation and placement has no run_tool call');
  const unplaced = publicListing({
    id: 'tool:unplaced-example', kind: 'tool', label: 'Unplaced', job: 'A tool without a runnable placement',
    invoke: { kind: 'model' }, runnable: false,
  });
  assert.equal('call' in unplaced, false, 'an invocation without a declared placement is not advertised as runnable');
  assert.equal(publicListing(null), null);
  assert.equal(publicListing({ id: 'not an id', label: 'X', job: 'Y' }), null);
});

test('a tool says the jobs it serves, and an encoder the space it encodes into and the pieces it reads', () => {
  const encoder = {
    kind: 'ai-tool-descriptor', id: 'tool:encode-text-example', job: 'Turn texts into meaning vectors', serves: ['encode'],
    encodes: {
      accepts: ['text'],
      space: { model: 'example/model', revision: 'abc', dim: 384, query_prompt: 'query: ' },
      reads: [{ result_kind: 'transcript', place: 'said', pieces_path: '$.segments', text_field: 'text', time_fields: { start: 'start', end: 'end' } }, { media_types: ['image/*'], place: 'seen' }],
    },
  };
  const { item } = admitToolDescriptor(encoder);
  assert.deepEqual(item.serves, ['encode']);
  assert.deepEqual(item.encodes, encoder.encodes, 'the declaration is read back whole');
  const refusedFor = change => admitToolDescriptor({ ...encoder, ...change }).refused?.reason;
  assert.match(refusedFor({ serves: [] }), /serves/);
  assert.match(refusedFor({ serves: ['transcribe'] }), /must serve "encode"/);
  assert.match(refusedFor({ encodes: { ...encoder.encodes, accepts: [] } }), /encodes\.accepts/);
  assert.match(refusedFor({ encodes: { ...encoder.encodes, space: { model: 'm', dim: 0 } } }), /encodes\.space/);
  assert.match(refusedFor({ encodes: { ...encoder.encodes, space: { model: 'm', dim: 8, weights: 'x' } } }), /encodes\.space holds only/);
  assert.match(refusedFor({ encodes: { ...encoder.encodes, reads: [{ place: 'said' }] } }), /encodes\.reads row is/);
  assert.equal(admitToolDescriptor({ kind: 'ai-tool-descriptor', id: 'tool:plain' }).item.serves, undefined, 'a tool that names no job has none');
});
