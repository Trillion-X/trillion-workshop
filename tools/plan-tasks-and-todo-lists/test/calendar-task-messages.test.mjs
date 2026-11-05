import test from 'node:test';
import assert from 'node:assert/strict';
import data from '../calendar-tasks.json' with { type: 'json' };
import { localStore } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { makeLists } from '../../keep-lists-of-rows/lists.mjs';
import { classifyMessage } from '../calendar-task-messages.mjs';
import { changeCalendarTask, readCalendarTasks, CalendarTasksError } from '../calendar-tasks.mjs';

const freshLists = () => makeLists({ eeaf: localStore(':memory:').eeaf });
const act = async (lists, input) => await changeCalendarTask(lists, input);

test('invites and invite updates go to Calendar, newsletters and spam to Other, everything else to Email', () => {
  assert.equal(classifyMessage({ id: '1', subject: 'Weekly sync', has_invite: true }), 'calendar');
  assert.equal(classifyMessage({ id: '2', subject: 'Updated invitation: Standup @ Mon' }), 'calendar');
  assert.equal(classifyMessage({ id: '3', subject: 'Our October news', list_unsubscribe: true }), 'other');
  assert.equal(classifyMessage({ id: '4', subject: 'Sale', labels: ['INBOX', 'CATEGORY_PROMOTIONS'] }), 'other');
  assert.equal(classifyMessage({ id: '5', subject: 'You are on the list. Unsubscribe any time' }), 'other');
  assert.equal(classifyMessage({ id: '6', subject: 'Lunch tomorrow?', from: 'a@example.test', labels: ['INBOX'] }), 'email');
  assert.equal(classifyMessage({ id: '7' }), 'email', 'a message with no facts falls to the default row');
  assert.equal(classifyMessage({ subject: 'Invitation: x', has_invite: true, list_unsubscribe: true }), 'calendar', 'the first matching row wins');
});

test('the rows are the rule: a caller-supplied row list replaces the defaults, and a broken pattern never matches', () => {
  const rows = [{ id: 'boss', field: 'from', contains: 'boss@', to: 'email' }, { id: 'bad', field: 'subject', matches: '(', to: 'other' }, { id: 'default', to: 'calendar' }];
  assert.equal(classifyMessage({ from: 'Boss@Example.test', subject: 'hi' }, rows), 'email');
  assert.equal(classifyMessage({ from: 'x@example.test', subject: '(' }, rows), 'calendar');
});

// A single message through the import road: the todo it made, whether it was already there, and the answer that undoes it.
async function one(lists, message) {
  await act(lists, { action: 'set_preferences', email_todos: true });
  const answer = await act(lists, { action: 'import_messages', messages: [message] });
  return { task: answer.tasks[0], kept: answer.imported === 0, ...(answer.undo ? { undo: answer.undo } : {}) };
}

test('one imported message makes one todo per message, in the list the rows choose, and a retry keeps it', async () => {
  const lists = freshLists();
  const message = { id: 'm-1', subject: 'Lunch tomorrow?', from: 'a@example.test', labels: ['INBOX'], url: 'https://mail.example.test/m-1' };
  const first = await one(lists, message);
  assert.equal(first.kept, false);
  assert.deepEqual([first.task.title, first.task.smart_list, first.task.source_id, first.task.source_url], ['Lunch tomorrow?', 'email', 'gmail:m-1', 'https://mail.example.test/m-1']);
  const again = await one(lists, message);
  assert.equal(again.kept, true);
  assert.equal(again.task.id, first.task.id);
  assert.equal((await readCalendarTasks(lists)).tasks.length, 1);
  const invite = await one(lists, { id: 'm-2', subject: 'Invitation: Review', has_invite: true });
  assert.equal(invite.task.smart_list, 'calendar');
  const bulk = await one(lists, { id: 'm-3', subject: '', list_unsubscribe: true, url: 'javascript:alert(1)' });
  assert.deepEqual([bulk.task.smart_list, bulk.task.title, bulk.task.source_url], ['other', data.email_split.untitled, null], 'an empty subject is named, an unsafe link is dropped');
  await act(lists, invite.undo);
  assert.equal((await readCalendarTasks(lists)).tasks.some(task => task.id === invite.task.id), false, 'the answer undoes the todo');
  await assert.rejects(async () => await one(lists, { subject: 'no id' }), error => error instanceof CalendarTasksError && /needs an id/.test(error.message));
});

test('with the split turned off every message goes to Email', async () => {
  const lists = freshLists();
  await act(lists, { action: 'set_preferences', email_split_contents: false });
  assert.equal((await one(lists, { id: 'a', subject: 'Invitation: x', has_invite: true })).task.smart_list, 'email');
});

test('import_messages does nothing until the person turns email todos on, then imports once and keeps the rest', async () => {
  const lists = freshLists();
  const messages = [
    { id: 'i-1', subject: 'Plan', labels: ['INBOX'] },
    { id: 'i-2', subject: 'Invitation: Demo', has_invite: true },
    { id: 'i-3', subject: 'Deals', list_unsubscribe: true },
  ];
  assert.deepEqual(await act(lists, { action: 'import_messages', messages }), { imported: 0, kept: 0, tasks: [], disabled: true });
  assert.equal((await readCalendarTasks(lists)).tasks.length, 0);
  await act(lists, { action: 'set_preferences', email_todos: true });
  const imported = await act(lists, { action: 'import_messages', messages });
  assert.deepEqual([imported.imported, imported.kept, imported.tasks.map(task => task.smart_list)], [3, 0, ['email', 'calendar', 'other']]);
  const next = await act(lists, { action: 'import_messages', messages: [...messages, { id: 'i-4', subject: 'New' }, { id: 'i-4', subject: 'New' }] });
  assert.deepEqual([next.imported, next.kept], [1, 4], 'known messages are kept; a message twice in one batch is one todo');
  assert.equal((await readCalendarTasks(lists)).tasks.length, 4);
  // Nothing remembers a deletion: a deleted todo is made again the next time its message is imported.
  await act(lists, { action: 'delete', task_id: imported.tasks[0].id });
  assert.equal((await act(lists, { action: 'import_messages', messages })).imported, 1);
  // A finished todo is still a todo: it is kept, not made again.
  await act(lists, { action: 'complete', task_id: imported.tasks[1].id });
  assert.equal((await act(lists, { action: 'import_messages', messages })).imported, 0);
  await act(lists, imported.undo);
});

test('the batch is bounded and every message needs an id', async () => {
  const lists = freshLists();
  await act(lists, { action: 'set_preferences', email_todos: true });
  const many = Array.from({ length: data.email_split.most_messages + 1 }, (_, index) => ({ id: `b-${index}`, subject: 'x' }));
  await assert.rejects(async () => await act(lists, { action: 'import_messages', messages: many }), error => error instanceof CalendarTasksError && /up to 50/.test(error.message));
  await assert.rejects(async () => await act(lists, { action: 'import_messages', messages: [] }), CalendarTasksError);
  await assert.rejects(async () => await act(lists, { action: 'import_messages', messages: [{ id: 'ok', subject: 'x' }, { subject: 'no id' }] }), /needs an id/);
  assert.equal((await readCalendarTasks(lists)).tasks.length, 0, 'a refused batch wrote nothing');
});
