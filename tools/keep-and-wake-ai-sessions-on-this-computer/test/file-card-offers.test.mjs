// Ported from old trillion test/file-card-offers.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. thingActions and takes-file are this tool's (src/work-workshop.mjs,
// parts/ui/show/file-field/takes-file.mjs). The old records/workshop-*.json held every Workshop row; this tool keeps two
// of them, and the rest live in each tool folder's tool-rows.json now, so the cards are read from both. Every assertion
// is the old one. Two fail today: tool:check-a-post (now tools/social-posts' row, which takes a post_id and no file) is
// not offered on a video's card, in the first test and in the for-thing route test; no commit or README says that was
// meant, so the old expectation stands.
// What a file's card and a thing's ⋯ menu offer (src/work-workshop.mjs thingActions, GET /work/api/workshop/for-thing):
// every tool or screen whose row marks it as taking a file of that kind, and every tool whose required inputs are all
// formats the thing carries, read from the real Workshop rows, never a fixed list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { thingActions, handleWorkWorkshop } from '../src/work-workshop.mjs';
import { takesFile, takesOf } from '../parts/ui/show/file-field/takes-file.mjs';

// Every Workshop row as /tools/list answers it: its screen, schema, and a run call only when it has something to run.
// The rows are this tool's records/workshop-*.json and every tool folder's tool-rows.json, where the Workshop's rows live now.
const toolsDir = new URL('../../', import.meta.url);
const rowFiles = [
  ...readdirSync(new URL('../records/', import.meta.url)).filter(name => name.startsWith('workshop-') && name.endsWith('.json')).map(name => new URL(`../records/${name}`, import.meta.url)),
  ...readdirSync(toolsDir).map(folder => new URL(`${folder}/tool-rows.json`, toolsDir)).filter(file => existsSync(file)),
];
const cards = rowFiles.flatMap(file => {
  const set = JSON.parse(readFileSync(file, 'utf8'));
  return (set.records ?? []).map(row => row.payload).filter(payload => payload?.id?.startsWith('tool:')).map(payload => ({
    tool_id: payload.id, label: payload.label ?? payload.id, job: payload.job, input_schema: payload.input_schema ?? { type: 'object' },
    ...(payload.screen ? { screen: payload.screen } : {}),
    next_call: payload.invoke ? { tool: 'run_tool', arguments: { tool_id: payload.id } } : null,
  }));
});
const ids = actions => actions.map(action => action.id);

test('a video is offered its editor, posting, its folder and the tools that take a recording', () => {
  const offered = thingActions(cards, { type: 'video/mp4', name: 'C9506S03.MP4' });
  for (const id of ['tool:screen-media-edit', 'tool:check-a-post', 'tool:screen-files', 'tool:screen-file', 'tool:transcribe-file', 'tool:who-is-in-this', 'tool:read-file-words']) assert.ok(ids(offered).includes(id), id);
  const edit = offered.find(action => action.id === 'tool:screen-media-edit');
  assert.equal(edit.kind, 'open');
  assert.equal(edit.surface, 'trillion.media-edit');
  // A tool's own screen opens as the row whose id is the tool's id, with the tool named in its input.
  const post = offered.find(action => action.id === 'tool:check-a-post');
  assert.equal(post.surface, 'tool:check-a-post');
  assert.equal(post.input.tool_id, 'tool:check-a-post');
  assert.deepEqual(post.input.media.identity, { from: 'file', field: 'identity' });
  const transcribe = offered.find(action => action.id === 'tool:transcribe-file');
  assert.deepEqual([transcribe.kind, transcribe.fills], ['run', { identity: 'namespace-file' }]);
});

test('a document is not offered what only takes a recording', () => {
  const offered = ids(thingActions(cards, { type: 'application/pdf', name: 'plan.pdf' }));
  assert.ok(!offered.includes('tool:screen-media-edit'));
  assert.ok(!offered.includes('tool:transcribe-file'));
  assert.ok(!offered.includes('tool:check-a-post'));
  assert.ok(offered.includes('tool:screen-file'));
  assert.ok(offered.includes('tool:read-file-words'));
});

test('a tool that needs more than the file is never a button that would fail', () => {
  // tool:set-file-facts takes a file but also needs the facts; tool:attach-finished-video needs an edit.
  const offered = ids(thingActions(cards, { type: 'video/mp4', name: 'clip.mp4' }));
  assert.ok(!offered.includes('tool:set-file-facts'));
  assert.ok(!offered.includes('tool:attach-finished-video'));
  // Browser bookmarks reads a browser's saved-items data file, never a video.
  assert.ok(!offered.includes('tool:save-browser-saved-items'));
});

test('a tool the person cannot run here is left out, and a new tool that takes a file appears with no card change', () => {
  const extra = { tool_id: 'tool:made-by-someone', label: 'Make captions', input_schema: { type: 'object', required: ['clip'] }, screen: { kind: 'described', inputs: { clip: { file: { takes: 'video' } } } }, next_call: { tool: 'run_tool' } };
  assert.ok(ids(thingActions([...cards, extra], { type: 'video/quicktime', name: 'a.mov' })).includes('tool:made-by-someone'));
  assert.ok(!ids(thingActions([...cards, { ...extra, runs_here: false }], { type: 'video/quicktime', name: 'a.mov' })).includes('tool:made-by-someone'));
});

test('a file with no media type is known by its name', () => {
  assert.ok(takesFile(takesOf('recording').accept, '', 'C9506S03.MP4'));
  assert.ok(!takesFile(takesOf('recording').accept, '', 'notes.txt'));
  assert.ok(takesFile(takesOf('seen-or-heard').accept, 'image/png', 'x'));
});

test('GET /work/api/workshop/for-thing answers from the person\'s own tool list', async () => {
  // The Workshop list holds only what can run or a tool's own screen; the workspace's own screens come from their rows.
  const listed = cards.filter(card => !card.screen?.surface);
  let asked = null;
  const person = { fetch: async request => {
    if (new URL(request.url).pathname !== '/tools/list') return Response.json({ error: 'Not found' }, { status: 404 });
    asked = await request.json();
    return Response.json({ tools: listed, runs: [] });
  } };
  const url = new URL('https://app.example/work/api/workshop/for-thing?type=video%2Fmp4&name=C9506S03.MP4&carries=namespace-file%2Ctrillion%3Afile');
  const response = await handleWorkWorkshop(new Request(url), { person, url });
  assert.equal(response.status, 200);
  const offered = ids((await response.json()).actions);
  assert.deepEqual(asked, { for_thing: { type: 'video/mp4', name: 'C9506S03.MP4', carries: ['namespace-file', 'trillion:file'] } });
  for (const id of ['tool:screen-media-edit', 'tool:screen-files', 'tool:check-a-post']) assert.ok(offered.includes(id), id);
});

test('any thing is offered the tools whose required inputs are all formats it carries, and nothing that takes a file', () => {
  const decision = thingActions(cards, { carries: ['trillion:decision'] });
  const tell = decision.find(action => action.id === 'tool:tell-your-ais-about-a-decision');
  assert.deepEqual([tell?.kind, tell?.fills], ['run', { case_id: 'trillion:decision' }]);
  // A thing that is not a file is never offered what takes a file, nor a screen that opens on one.
  assert.ok(!ids(decision).includes('tool:transcribe-file'));
  assert.ok(!ids(decision).includes('tool:screen-media-edit'));
  // A screen is offered what takes a screen, and a new tool that takes one appears with no menu change.
  const extra = { tool_id: 'tool:about-a-screen', label: 'Explain this screen', input_schema: { type: 'object', required: ['screen'], properties: { screen: { type: 'string', format: 'trillion:screen' } } }, next_call: { tool: 'run_tool' } };
  assert.ok(ids(thingActions([...cards, extra], { carries: ['trillion:screen'] })).includes('tool:about-a-screen'));
  assert.ok(!ids(thingActions([...cards, extra], { carries: ['trillion:decision'] })).includes('tool:about-a-screen'));
  // A tool that also needs something the thing does not carry is never a button that would fail.
  const needsMore = { ...extra, tool_id: 'tool:needs-more', input_schema: { type: 'object', required: ['screen', 'note'], properties: { screen: { type: 'string', format: 'trillion:screen' }, note: { type: 'string' } } } };
  assert.ok(!ids(thingActions([...cards, needsMore], { carries: ['trillion:screen'] })).includes('tool:needs-more'));
});

test('a screen that opens on a thing is offered on every thing of its kinds, filled from the thing, never on a file', () => {
  const onScreen = thingActions(cards, { carries: ['trillion:screen'] });
  const edit = onScreen.find(action => action.id === 'tool:screen-canvas-edit');
  assert.ok(edit, 'Edit on canvas is offered on a screen');
  assert.deepEqual([edit.kind, edit.surface, edit.label], ['open', 'trillion.canvas-edit', 'Edit on canvas']);
  assert.deepEqual(edit.input.id, { from: 'thing', field: 'address' });
  assert.ok(ids(thingActions(cards, { carries: ['trillion:tour'] })).includes('tool:screen-canvas-edit'));
  assert.ok(!ids(thingActions(cards, { carries: ['trillion:decision'] })).includes('tool:screen-canvas-edit'));
  assert.ok(!ids(thingActions(cards, { type: 'video/mp4', name: 'a.mp4', carries: ['namespace-file', 'trillion:screen'] })).includes('tool:screen-canvas-edit'));
});
