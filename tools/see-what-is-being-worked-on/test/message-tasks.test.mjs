// test/message-tasks.test.mjs
//
// The person's messages as tasks (src/message-task-canvas.mjs messageTasks), read by the Task map screen
// (src/workspace/message-task-canvas-screen.tsx): blocks become tasks with their pursuit, feature and progress, a parent's
// progress is the share of its tasks done, a message no AI broke down is one honest row, and the shared rule filter
// narrows the tasks to one pursuit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NOT_BROKEN, NO_PURSUIT, doneOfAsked, messageTasks } from 'trillion-workshop/tools/see-what-is-being-worked-on/message-task-canvas.mjs';
import { initSync, filterRecords } from 'trillion-workshop/tools/formula-engine/built-stored-bytes/formula-engine/formula_engine.js';
initSync({ module: readFileSync(new URL(import.meta.resolve('trillion-workshop/tools/formula-engine/built-stored-bytes/formula-engine/formula_engine_bg.wasm'))) });
const filterRowsByRules = ({ tree, fields, rows }) => filterRecords({ records: rows, fields, tree });

const launch = { id: 'message:launch', speaker: 'person', app: 'Codex', text: 'Ship the landing page and write the welcome email.', at: '2026-10-06T09:00:00Z', about: [{ kind: 'pursuit', id: 'pursuit:launch' }] };
const coaching = { id: 'message:coaching', speaker: 'person', app: 'Claude', text: 'Plan next week of pottery lessons.', at: '2026-10-06T10:00:00Z', about: [{ kind: 'decision', id: 'case:lessons' }] };
const loose = { id: 'message:loose', speaker: 'person', app: 'Trillion', text: 'Remind me to call the printer.', at: '2026-10-06T11:00:00Z' };
const reply = { id: 'message:reply', speaker: 'ai', app: 'Codex', text: 'On it.', at: '2026-10-06T09:01:00Z' };
const related = [
  { id: 'pursuit:launch', kind: 'Pursuit', label: 'Launch Trillion' },
  { id: 'pursuit:coach', kind: 'Pursuit', label: 'Coach pottery' },
  { id: 'case:lessons', kind: 'Decision', label: 'Which lessons', about: [{ id: 'pursuit:coach', kind: 'pursuit' }] },
];
const blocks = [
  { id: 'block:page', source_id: launch.id, start: 0, end: 21, title: 'Landing page', state: 'in_progress', at: '2026-10-06T09:05:00Z' },
  { id: 'block:hero', source_id: launch.id, parent_id: 'block:page', title: 'Write the hero words', state: 'done', progress: 100, proof: [{ kind: 'file', id: 'file:hero' }] },
  { id: 'block:shot', source_id: launch.id, parent_id: 'block:page', title: 'Take the product picture', state: 'open' },
  { id: 'block:footer', source_id: launch.id, parent_id: 'block:page', title: 'Add the footer links', state: 'in_progress', progress: 40 },
  { id: 'block:email', source_id: launch.id, start: 26, end: 50, title: 'Write the welcome email', state: 'open', progress: 10 },
  { id: 'block:week', source_id: coaching.id, title: 'Plan the week of lessons', state: 'open' },
];
const answer = { messages: [launch, coaching, loose, reply], arrivals: [], activity: [], blocks, related };
const read = messageTasks(answer);
const byId = id => read.tasks.find(task => task.id === id);

test('each block is a task in its own words, with its pursuit, feature and recorded progress', () => {
  const hero = byId('block:hero');
  assert.equal(hero.title, 'Write the hero words');
  assert.equal(hero.pursuit, 'pursuit:launch', 'the pursuit comes from the message it came from');
  assert.equal(hero.feature, 'block:page', 'its feature is the block it sits under');
  assert.equal(hero.progress, 100);
  assert.equal(byId('block:footer').progress, 40);
  assert.equal(byId('block:shot').progress, null, 'no recorded progress is never guessed');
  assert.equal(byId('block:page').feature, 'block:page', 'a block holding blocks heads its own feature');
  assert.equal(byId('block:email').feature, 'pursuit:launch', 'a lone top-level block is filed under its pursuit');
  assert.equal(byId('block:email').detail, launch.text.slice(26, 50), 'its words are the exact part of the message it came from');
  assert.equal(byId('block:email').source_message, launch.text);
  assert.deepEqual(byId('block:hero').source_span, { message_id: launch.id, start: 0, end: 21, text: launch.text.slice(0, 21), task_id: 'block:hero' }, 'a task with no words of its own came from the words of the feature it was split from');
  assert.equal(byId('block:week').pursuit, 'pursuit:coach', 'a pursuit reached through the decision the message is about');
  assert.deepEqual(read.features.find(feature => feature.id === 'block:page'), { id: 'block:page', label: 'Landing page' });
  assert.deepEqual(read.features.find(feature => feature.id === 'pursuit:launch'), { id: 'pursuit:launch', label: 'Launch Trillion', pursuit: 'pursuit:launch' }, "a pursuit's loose tasks say whose they are");
  assert.ok(read.pursuits.some(pursuit => pursuit.id === 'pursuit:launch' && pursuit.label === 'Launch Trillion'));
});

test("a block holding blocks shows the share of them done, and done-of-asked counts only tasks holding none", () => {
  const page = byId('block:page');
  assert.equal(page.progress, 33, 'one of three tasks done');
  assert.equal(page.done_count, 1);
  assert.equal(page.asked_count, 3);
  assert.equal(page.leaf, false);
  const launchTasks = read.tasks.filter(task => task.pursuit === 'pursuit:launch');
  assert.deepEqual(doneOfAsked(launchTasks), { done: 1, asked: 4 }, 'the heading block is not counted twice');
});

test('a block naming its own pursuit keeps it, and its tasks inherit it', () => {
  const own = messageTasks({ ...answer, blocks: [
    { id: 'block:own', source_id: loose.id, title: 'Call the printer', state: 'open', about: [{ kind: 'pursuit', id: 'pursuit:coach' }] },
    { id: 'block:own-child', source_id: loose.id, parent_id: 'block:own', title: 'Find the number', state: 'done' },
  ] });
  assert.equal(own.tasks.find(task => task.id === 'block:own').pursuit, 'pursuit:coach');
  assert.equal(own.tasks.find(task => task.id === 'block:own-child').pursuit, 'pursuit:coach');
  assert.equal(own.tasks.find(task => task.id === 'block:own-child').progress, 100, 'done counts as all of it');
});

test('a message no AI broke down is one row saying so, never a guessed task, and AI replies are not tasks', () => {
  const rows = read.tasks.filter(task => task.kind === 'message');
  assert.deepEqual(rows.map(row => row.id), [loose.id]);
  const [row] = rows;
  assert.equal(row.status, 'unbroken');
  assert.equal(row.feature, NOT_BROKEN);
  assert.equal(row.pursuit, NO_PURSUIT);
  assert.equal(row.progress, null);
  assert.equal(row.source_message, loose.text);
  assert.ok(!read.tasks.some(task => task.id === reply.id));
  assert.ok(!read.tasks.some(task => task.id === launch.id), 'a message with tasks is not listed again');
  assert.deepEqual(doneOfAsked(rows), { done: 0, asked: 1 }, 'it is asked and not done');
});

test('the shared rule filter narrows the tasks to one pursuit', async () => {
  const tree = { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'pursuit', operator: 'is_any_of', params: { values: ['pursuit:coach'] } }] };
  const { matches } = await filterRowsByRules({ tree, fields: [{ id: 'pursuit', kind: 'choice' }], rows: read.tasks.map(task => ({ pursuit: task.pursuit })) });
  assert.deepEqual(matches.map(at => read.tasks[at].id), ['block:week']);
  const none = { ...tree, rules: [{ ...tree.rules[0], params: { values: [NO_PURSUIT] } }] };
  const unfiled = await filterRowsByRules({ tree: none, fields: [{ id: 'pursuit', kind: 'choice' }], rows: read.tasks.map(task => ({ pursuit: task.pursuit })) });
  assert.deepEqual(unfiled.matches.map(at => read.tasks[at].id), [loose.id]);
});
