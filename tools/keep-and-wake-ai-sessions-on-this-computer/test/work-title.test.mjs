// test/work-title.test.mjs
//
// Every piece of work is shown by one short plain title (src/work-title.mjs): the asker's `said` when given, else one
// derived from the job's own words when it is handed off, kept on the record, and read by every surface. These tests
// fail the moment a long job reaches a card whole, a title carries ids, links, marks or program words, a title is cut
// mid-word, or open work handed off before titles were kept stays untitled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK, TITLE_MAX, titleOf, workTitle } from '../../shared-code/src/work-title.mjs';
import { makeAgents } from '../../shared-code/src/agents.mjs';
import { agentStoreForTests } from '../../shared-code/test/agent-store-for-tests.mjs';
import { liveWork } from '../../hand-off-jobs-between-agents/src/live-work.mjs';
import { sqliteHost } from '../src/local-store.mjs';
import { messageTaskGraph } from '../../see-what-is-being-worked-on/message-task-canvas.mjs';

const LONG = `## Handoff summary\n\nDevelop the **changelog** into a richer zoomable, media-linked view that links every entry to its recording. ${'More detail for the AI about how to do it, with steps and checks. '.repeat(40)}`;

test('a long job becomes its first plain sentence, cut at a word boundary', () => {
  assert.ok(LONG.length > 2000);
  const title = workTitle(LONG);
  assert.ok(title.length <= TITLE_MAX, title);
  assert.ok(title.startsWith('Develop the changelog into a richer zoomable, media-linked view'), title);
  assert.ok(title.endsWith('…'));
  assert.ok(LONG.includes(title.slice(0, -1).replace('changelog', '**changelog**').trimEnd()), 'cut on a word the job holds');
});

test('a title carries no marks, links, addresses, paths, ids or header labels', () => {
  assert.equal(workTitle('Handoff: fix h_4677423f69aed1fb495164bc so the [login](https://x.com/a) page works.'), 'Fix so the login page works');
  assert.equal(workTitle('Read /work/sample/notes/plan.md and tidy it. Then more.'), 'Read and tidy it');
  assert.equal(workTitle('# Fix the login page on phones\nbody'), 'Fix the login page on phones');
  assert.equal(workTitle('- *Plan* the `week` ahead'), 'Plan the week ahead');
});

test('a sentence written for the AI (program words) is passed over for the next plain one', () => {
  assert.equal(workTitle('Use list_pursuits first. Draft the launch post for Friday.'), 'Draft the launch post for Friday');
  assert.equal(workTitle('Take it with take_work, then finish_work.'), FALLBACK);
});

test('work with no plain words still has a title, and a kept said always wins', () => {
  assert.equal(workTitle('https://example.com/only'), FALLBACK);
  assert.equal(workTitle(''), FALLBACK);
  assert.equal(titleOf({ said: 'Pick my needle mover', job: LONG }), 'Pick my needle mover');
  assert.ok(titleOf({ said: '  ', job: LONG }).startsWith('Develop the changelog'));
});

test('hand_off keeps the derived title on the record, and every view of the work reads it', () => {
  const store = agentStoreForTests();
  const agents = makeAgents({ store });
  const handed = agents.handOff({ job: LONG, request_key: 'long-1' }).handoff;
  assert.equal(handed.said, workTitle(LONG));
  assert.equal(store.handoff(handed.handoff_id).said, workTitle(LONG), 'kept on the record');
  assert.equal(agents.read({ handoff_id: handed.handoff_id }).handoff.said, workTitle(LONG));
  assert.equal(agents.board().work.find(item => item.handoff_id === handed.handoff_id).said, workTitle(LONG));
  assert.equal(agents.recentWork().work.find(item => item.handoff_id === handed.handoff_id).said, workTitle(LONG));
  const given = agents.handOff({ job: LONG, said: 'Make the changelog zoomable', request_key: 'long-2' }).handoff;
  assert.equal(given.said, 'Make the changelog zoomable');
  const graph = messageTaskGraph({ messages: [], arrivals: [], asked: [], blocks: [], activity: [], related: [], handoffs: [{ ...store.handoff(handed.handoff_id), said: undefined }] });
  assert.equal(graph.nodes.find(node => node.id === handed.handoff_id).label, workTitle(LONG), 'the work map names work by the same title');
});

test('open work handed off before titles were kept is titled one page at a time', () => {
  const store = agentStoreForTests();
  const agents = makeAgents({ store });
  const ids = [1, 2, 3].map(n => agents.handOff({ job: `Sort the receipts for month ${n}. Then file them.`, request_key: `old-${n}` }).handoff.handoff_id);
  for (const id of ids) store.putHandoff({ ...store.handoff(id), said: null });
  const kept = agents.handOff({ job: LONG, said: 'Keep my own words', request_key: 'mine' }).handoff.handoff_id;
  let pass = agents.titleOpenWork({ limit: 2 });
  assert.ok(pass.after, 'a full page says where the next one starts');
  let titled = pass.titled;
  while (pass.after) { pass = agents.titleOpenWork({ after: pass.after, limit: 2 }); titled += pass.titled; }
  assert.equal(titled, 3);
  for (const [n, id] of ids.entries()) assert.equal(store.handoff(id).said, `Sort the receipts for month ${n + 1}`);
  assert.equal(store.handoff(kept).said, 'Keep my own words');
  assert.equal(agents.titleOpenWork().titled, 0, 'a second pass changes nothing');
});

test('a held job on a plan that keeps nothing gets the same title', () => {
  const { sql } = sqliteHost(':memory:');
  const held = liveWork({ sql }).put({ asked_id: 'asked:1', job: LONG }).handoff;
  assert.equal(held.said, workTitle(LONG));
});

test('AI activity names handed-off work by its kept title, never by the job', async () => {
  const { default: marks } = await import('../../see-what-my-ais-did/activity-marks.json', { with: { type: 'json' } });
  for (const tool of ['hand_off', 'take_work', 'finish_work']) {
    const mark = marks.marks.find(row => row.tool === tool);
    assert.deepEqual(mark.title[0], { from: 'result', path: ['handoff', 'said'] }, `${tool} reads the kept title first`);
    assert.ok(mark.title.every(place => place.path.at(-1) !== 'job'), `${tool} never names work by its job`);
  }
});
