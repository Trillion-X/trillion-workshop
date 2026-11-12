import test from 'node:test';
import assert from 'node:assert/strict';
import data from '../calendar-tasks.json' with { type: 'json' };
import { localStore } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { planSchedule } from '../parts/ui/show/schedule-calendar/schedule-planner.mjs';
import { makeLists } from '../../keep-lists-of-rows/lists.mjs';
import {
  changeCalendarTask, handleCalendarTasksRequest, readCalendarTaskCollections, readCalendarTasks, silentAt,
} from '../calendar-tasks.mjs';

function listsOwner() {
  const definitions = new Map([[data.list.id, structuredClone(data.list)], [data.collections.id, structuredClone(data.collections)]]);
  const rows = new Map();
  const rowsByList = new Map([[data.list.id, rows], [data.collections.id, new Map()]]);
  const calls = [];
  return {
    definitions, rows, collectionRows: rowsByList.get(data.collections.id), calls,
    ensure(definition, options) {
      calls.push(['ensure', definition.id, options.actor.by]);
      if (!definitions.has(definition.id)) {
        definitions.set(definition.id, structuredClone(definition));
        rowsByList.set(definition.id, new Map());
      }
    },
    find(id) { return definitions.has(id) ? structuredClone(definitions.get(id)) : null; },
    save(definition, options) { calls.push(['save', definition.id, options.actor.by]); definitions.set(definition.id, structuredClone(definition)); return { list: definition }; },
    read(id, options) {
      calls.push(['read', id, options.only]);
      assert.ok(rowsByList.has(id));
      const listRows = rowsByList.get(id);
      const all = [...listRows.values()].sort((a, b) => a.id.localeCompare(b.id));
      const start = options.cursor ? all.findIndex(row => row.id === options.cursor) + 1 : 0;
      const result = options.limit ? all.slice(start, start + options.limit) : all;
      const complete = !options.limit || start + result.length >= all.length;
      return {
        rows: result.map(row => structuredClone(row)),
        page: { complete, next_cursor: complete ? null : result.at(-1)?.id ?? null },
      };
    },
    row(id, rowId) { const listRows = rowsByList.get(id); return listRows?.has(rowId) ? structuredClone(listRows.get(rowId)) : null; },
    putRows(id, { rows: incoming = [], remove = [] }, options) {
      const listRows = rowsByList.get(id);
      assert.ok(listRows);
      calls.push(['putRows', id, options.actor.by]);
      for (const rowId of remove) listRows.delete(rowId);
      const kept = incoming.map(row => {
        const value = { ...(listRows.get(row.id)?.values ?? {}) };
        for (const [key, item] of Object.entries(row.values)) {
          if (item === null) delete value[key];
          else value[key] = item;
        }
        if (id === data.list.id && value.status === undefined) value.status = definitions.get(id).fields.find(field => field.id === 'status').starts;
        const saved = { id: row.id, values: value };
        listRows.set(row.id, saved);
        return structuredClone(saved);
      });
      return { kept };
    },
  };
}

test('Calendar task actions create, schedule and complete rows through generic Lists', async () => {
  const lists = listsOwner();
  const created = await changeCalendarTask(lists, { action: 'create', request_key: 'task-1', title: 'Write the brief', duration_minutes: 45, due: '2026-10-20' }, { now: () => Date.parse('2026-10-20T08:00:00.000Z') });
  assert.deepEqual(created.task, {
    id: 'calendar-task-1', title: 'Write the brief', parent_id: null, collection_id: null, description: '', priority: null, labels: [], duration_minutes: 45, due: '2026-10-20',
    minimum_duration_minutes: null, slice_of: null, deadline_type: null, start_on: null, blocked_by: [], pinned_until: null, snoozed_until: null,
    created_at: '2026-10-20T08:00:00.000Z', time_spent_minutes: 0, smart_list: null, auto_placed: false,
    starts_at: null, ends_at: null, source_id: null, source_url: null, status: 'To do', may_move: true, may_cancel: false,
  });
  assert.equal(created.kept, false);
  assert.equal((await changeCalendarTask(lists, { action: 'create', request_key: 'task-1', title: 'Write the brief', duration_minutes: 45, due: '2026-10-20' })).kept, true,
    'a retried creation request returns its original row');
  const scheduled = await changeCalendarTask(lists, { action: 'schedule', task_id: created.task.id, start: '2026-10-14T10:00:00-07:00' });
  assert.equal(scheduled.task.starts_at, '2026-10-14T17:00:00.000Z');
  assert.equal(scheduled.task.ends_at, '2026-10-14T17:45:00.000Z');
  const resized = await changeCalendarTask(lists, { action: 'schedule', task_id: created.task.id, start: '2026-10-14T17:00:00Z', end: '2026-10-14T18:30:00Z' });
  assert.equal(resized.task.duration_minutes, 90, 'a resize becomes the task duration used by its next schedule');
  const completed = await changeCalendarTask(lists, { action: 'complete', task_id: created.task.id });
  assert.equal(completed.task.status, 'Done');
  assert.equal(completed.task.may_move, false);
  assert.ok(lists.calls.filter(([name]) => name === 'putRows').length >= 3);
  assert.ok(lists.calls.every(([name]) => name !== 'direct-write'), 'no task state is written outside Lists');
});

test('Calendar manual reorder delegates the visible anchor and placement to generic Lists', async () => {
  const lists = listsOwner();
  const first = await changeCalendarTask(lists, { action: 'create', request_key: 'manual-first', title: 'First', duration_minutes: 15 });
  const second = await changeCalendarTask(lists, { action: 'create', request_key: 'manual-second', title: 'Second', duration_minutes: 15 });
  let move;
  lists.moveRow = (id, input, options) => { move = { id, input, actor: options.actor }; return { moved: true }; };
  const answer = await changeCalendarTask(lists, {
    action: 'reorder', task_id: second.task.id, anchor_id: first.task.id, placement: 'before',
  });
  assert.deepEqual(move, {
    id: data.list.id,
    input: { row_id: second.task.id, index: data.list.ordering.index, anchor_id: first.task.id, placement: 'before' },
    actor: { by: 'calendar' },
  });
  assert.equal(answer.task.id, second.task.id);
  assert.equal(answer.moved, true);
});

test('Calendar HTTP manual order reads and moves exact persisted rows through the real Lists owner', async () => {
  const store = localStore(':memory:');
  try {
    const lists = makeLists({ eeaf: store.eeaf });
    const first = (await changeCalendarTask(lists, { action: 'create', request_key: 'http-first', title: 'Z first', duration_minutes: 15 })).task;
    const second = (await changeCalendarTask(lists, { action: 'create', request_key: 'http-second', title: 'A second', duration_minutes: 15 })).task;
    await lists.fillOrdering(data.list.id);
    for (let page = 0; page < 100 && !store.eeaf.indexReady(`record:${data.list.row_type}`, data.list.ordering.index); page++) {
      store.eeaf.backfillTables({ limit: 10 });
    }
    const read = async sort => {
      const response = await handleCalendarTasksRequest(lists, new Request(`https://person/calendar/tasks?sort=${sort}`));
      assert.equal(response.status, 200);
      return response.json();
    };
    const before = await read('manual');
    assert.deepEqual(before.ordering, { ready: true, index: data.list.ordering.index });
    assert.deepEqual(before.tasks.map(task => task.id), [first.id, second.id], 'manual order reaches the endpoint instead of title/date sorting');
    const response = await handleCalendarTasksRequest(lists, new Request('https://person/calendar/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reorder', task_id: second.id, anchor_id: first.id, placement: 'before' }),
    }));
    assert.equal(response.status, 200);
    const answer = await response.json();
    assert.equal(answer.task.id, second.id);
    assert.equal(answer.moved, true);
    assert.deepEqual((await read('manual')).tasks.map(task => task.id), [second.id, first.id]);
    const refused = await handleCalendarTasksRequest(lists, new Request('https://person/calendar/tasks?sort=unknown'));
    assert.equal(refused.status, 400, 'unknown ordering is refused before reading a fallback');
  } finally { store.close?.(); }
});

test('duplicating a task keeps editable details but starts a fresh unscheduled task and retries by request key', async () => {
  const lists = listsOwner();
  const parent = await changeCalendarTask(lists, { action: 'create', request_key: 'copy-parent', title: 'Plan the launch', duration_minutes: 45 });
  const source = await changeCalendarTask(lists, {
    action: 'create', request_key: 'copy-source', title: 'Write launch notes', duration_minutes: 30,
    due: '2026-10-20', parent_id: parent.task.id, description: 'Include the customer examples.', priority: 'high', labels: ['Launch'],
  });
  await changeCalendarTask(lists, { action: 'schedule', task_id: source.task.id, start: '2026-10-14T10:00:00Z' });
  const copied = await changeCalendarTask(lists, { action: 'duplicate', task_id: source.task.id, request_key: 'copy-one' });
  assert.equal(copied.kept, false);
  assert.equal(copied.task.title, source.task.title);
  assert.equal(copied.task.description, 'Include the customer examples.');
  assert.equal(copied.task.priority, 'high');
  assert.deepEqual(copied.task.labels, ['Launch']);
  assert.equal(copied.task.duration_minutes, 30);
  assert.equal(copied.task.due, '2026-10-20');
  assert.equal(copied.task.parent_id, parent.task.id);
  assert.equal(copied.task.duplicate_of, source.task.id);
  assert.equal(copied.task.status, 'To do');
  assert.equal(copied.task.starts_at, null);
  assert.equal(copied.task.ends_at, null);
  assert.equal((await changeCalendarTask(lists, { action: 'duplicate', task_id: source.task.id, request_key: 'copy-one' })).kept, true);
  const other = await changeCalendarTask(lists, { action: 'create', request_key: 'copy-other', title: 'Different task', duration_minutes: 20 });
  await assert.rejects(async () => await changeCalendarTask(lists, { action: 'duplicate', task_id: other.task.id, request_key: 'copy-one' }), /different task copy/);
});

test('Calendar tasks can reopen completed rows and delete a row through Lists', async () => {
  const lists = listsOwner();
  const made = await changeCalendarTask(lists, { action: 'create', request_key: 'reopen-delete', title: 'Send the notes', duration_minutes: 15 });
  assert.equal((await changeCalendarTask(lists, { action: 'complete', task_id: made.task.id })).task.status, 'Done');
  assert.equal((await changeCalendarTask(lists, { action: 'reopen', task_id: made.task.id })).task.status, 'To do');
  const { undo, ...deleted } = await changeCalendarTask(lists, { action: 'delete', task_id: made.task.id });
  assert.deepEqual(deleted, { id: made.task.id, removed: true });
  assert.equal(undo.action, 'restore');
  assert.equal(lists.rows.has(made.task.id), false);
});

test('an exact task read reaches beyond the first page and ignores the calendar date window', async () => {
  const lists = listsOwner();
  let selected;
  for (let index = 0; index < 51; index++) {
    selected = (await changeCalendarTask(lists, { action: 'create', request_key: `exact-page-${index}`, title: `Task ${index}`, duration_minutes: 15 })).task;
  }
  const saved = lists.rows.get(selected.id);
  lists.rows.delete(selected.id);
  selected = { ...selected, id: 'zz-selected-beyond-page' };
  lists.rows.set(selected.id, { ...saved, id: selected.id });
  await changeCalendarTask(lists, { action: 'schedule', task_id: selected.id, start: '2026-11-14T10:00:00Z' });
  const answer = await readCalendarTasks(lists, {
    from: '2026-10-14T00:00:00Z', to: '2026-10-15T00:00:00Z', task_id: selected.id,
  });
  assert.equal(answer.tasks.length, 51, 'the normal first-page unscheduled context remains alongside the exact row');
  assert.ok(answer.tasks.some(task => task.id === selected.id), 'the exact row beyond the first page remains included outside the date window');
  await assert.rejects(async () => await readCalendarTasks(lists, { task_id: 'deleted-task' }), /task/i,
    'a deleted exact task fails closed instead of producing a draft');
});

test('Calendar task reads keep unscheduled work visible and range scheduled work', async () => {
  const lists = listsOwner();
  await changeCalendarTask(lists, { action: 'create', request_key: 'free', title: 'Unscheduled', duration_minutes: 20 });
  const scheduled = await changeCalendarTask(lists, { action: 'create', request_key: 'in', title: 'In range', duration_minutes: 30 });
  await changeCalendarTask(lists, { action: 'schedule', task_id: scheduled.task.id, start: '2026-10-14T09:00:00Z', end: '2026-10-14T09:30:00Z' });
  const outside = await changeCalendarTask(lists, { action: 'create', request_key: 'out', title: 'Outside', duration_minutes: 30 });
  await changeCalendarTask(lists, { action: 'schedule', task_id: outside.task.id, start: '2026-10-16T09:00:00Z', end: '2026-10-16T09:30:00Z' });
  const answer = await readCalendarTasks(lists, { from: '2026-10-14T00:00:00Z', to: '2026-10-15T00:00:00Z' });
  assert.deepEqual(answer.tasks.map(task => task.title), ['Unscheduled', 'In range']);
  assert.equal(answer.list_id, data.list.id);
  assert.ok(lists.calls.some(([name, id]) => name === 'read' && id === data.list.id));
});

test('task route validates inputs and reports current list rows', async () => {
  const lists = listsOwner();
  const bad = await handleCalendarTasksRequest(lists, new Request('https://person/calendar/tasks', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create', title: 'No duration' }),
  }));
  assert.equal(bad.status, 400);
  const made = await handleCalendarTasksRequest(lists, new Request('https://person/calendar/tasks', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'create', request_key: 'route-1', title: 'Call Sam', duration_minutes: 15 }),
  }));
  assert.equal(made.status, 200);
  const read = await handleCalendarTasksRequest(lists, new Request('https://person/calendar/tasks?from=2026-10-12T00:00:00Z&to=2026-10-13T00:00:00Z'));
  assert.equal(read.status, 200);
  const body = await read.json();
  assert.equal(body.tasks[0].title, 'Call Sam');
  assert.deepEqual(body.collections, []);
});

test('unschedule clears both calendar times while keeping the task row', async () => {
  const lists = listsOwner();
  const made = await changeCalendarTask(lists, { action: 'create', request_key: 'remove-time', title: 'Review notes', duration_minutes: 30 });
  await changeCalendarTask(lists, { action: 'schedule', task_id: made.task.id, start: '2026-10-14T09:00:00Z' });
  const result = await changeCalendarTask(lists, { action: 'unschedule', task_id: made.task.id });
  assert.equal(result.task.starts_at, null);
  assert.equal(result.task.ends_at, null);
  assert.equal(result.task.status, 'To do');
  assert.equal(lists.rows.has(made.task.id), true);
});

test('update changes a task title, duration and due date, including clearing due', async () => {
  const lists = listsOwner();
  const made = await changeCalendarTask(lists, { action: 'create', request_key: 'edit-me', title: 'Draft', duration_minutes: 25, due: '2026-10-20' });
  const updated = await changeCalendarTask(lists, {
    action: 'update', task_id: made.task.id, title: 'Review draft', duration_minutes: 50, due: null,
  });
  assert.equal(updated.task.title, 'Review draft');
  assert.equal(updated.task.duration_minutes, 50);
  assert.equal(updated.task.due, null);
});

test('calendar tasks create and update typed description, priority and labels through Lists', async () => {
  const lists = listsOwner();
  const made = await changeCalendarTask(lists, {
    action: 'create', request_key: 'described', title: 'Prepare the review', duration_minutes: 40,
    description: '  Bring the current draft.  ', priority: 'high', labels: ['Work', 'Review'],
    source_id: 'mail:account-1:message-2', source_url: 'https://mail.google.com/mail/u/0/#all/message-2',
  });
  assert.deepEqual(
    [made.task.description, made.task.priority, made.task.labels],
    ['Bring the current draft.', 'high', ['Work', 'Review']],
  );
  assert.deepEqual(
    [lists.rows.get(made.task.id).values.description, lists.rows.get(made.task.id).values.priority, lists.rows.get(made.task.id).values.labels],
    ['Bring the current draft.', 'high', ['Work', 'Review']],
  );

  assert.deepEqual(
    (await changeCalendarTask(lists, {
      action: 'create', request_key: 'described', title: 'Prepare the review', duration_minutes: 40,
      description: 'Bring the current draft.', priority: 'high', labels: ['Work', 'Review'],
      source_id: 'mail:account-1:message-2', source_url: 'https://mail.google.com/mail/u/0/#all/message-2',
    })).kept,
    true,
    'a retried request matches the normalized detail fields',
  );
  await assert.rejects(async () => await changeCalendarTask(lists, {
    action: 'create', request_key: 'described', title: 'Prepare the review', duration_minutes: 40,
    description: 'Bring the current draft.', priority: 'high', labels: ['Different'],
    source_id: 'mail:account-1:message-2', source_url: 'https://mail.google.com/mail/u/0/#all/message-2',
  }), /different task/);
  const scheduled = await changeCalendarTask(lists, { action: 'schedule', task_id: made.task.id, start: '2026-10-14T09:00:00Z' });
  const completed = await changeCalendarTask(lists, { action: 'complete', task_id: made.task.id });
  const updated = await changeCalendarTask(lists, {
    action: 'update', task_id: made.task.id, description: null, priority: null, labels: [],
  });
  assert.deepEqual(
    [updated.task.description, updated.task.priority, updated.task.labels],
    ['', null, []],
  );
  assert.deepEqual(
    [updated.task.id, updated.task.starts_at, updated.task.ends_at, updated.task.status, updated.task.source_id, updated.task.source_url],
    [made.task.id, scheduled.task.starts_at, scheduled.task.ends_at, completed.task.status, made.task.source_id, made.task.source_url],
  );
});

test('calendar task detail fields reject unknown priorities and out-of-bounds text or labels', async () => {
  const lists = listsOwner();
  let invalidRequest = 0;
  const create = async fields => await changeCalendarTask(lists, {
    action: 'create', request_key: `invalid-${++invalidRequest}`, title: 'Validate fields', duration_minutes: 30, ...fields,
  });
  await assert.rejects(async () => await create({ priority: 'critical' }), /Choose low, medium, high or super priority/);
  await assert.rejects(async () => await create({ description: 'x'.repeat(data.limits.description_chars + 1) }), /10000 characters or fewer/);
  await assert.rejects(async () => await create({ labels: [''] }), /non-empty labels/);
  await assert.rejects(async () => await create({ labels: ['Same', ' same '] }), /non-empty labels/);
  await assert.rejects(async () => await create({ labels: ['x'.repeat(data.limits.label_chars + 1)] }), /non-empty labels/);
  await assert.rejects(async () => await create({ labels: Array.from({ length: data.limits.labels_per_task + 1 }, (_, index) => `Label ${index}`) }), /non-empty labels/);
});

test('task provenance is validated and survives create, update, Lists storage and calendar reads', async () => {
  const store = localStore(':memory:');
  const lists = makeLists({ eeaf: store.eeaf, newId: () => 'provenance-task' });
  const created = await changeCalendarTask(lists, {
    action: 'create', request_key: 'source-task', title: 'Review imported task', duration_minutes: 30,
    source_id: 'amie-task-81', source_url: 'https://app.amie.so/tasks/81',
  });
  assert.equal(created.task.source_id, 'amie-task-81');
  assert.equal(created.task.source_url, 'https://app.amie.so/tasks/81');
  assert.equal((await lists.row(data.list.id, created.task.id)).values.source_id, 'amie-task-81');
  assert.deepEqual((await lists.find(data.list.id)).fields.map(field => field.id), data.list.fields.map(field => field.id));

  const updated = await changeCalendarTask(lists, { action: 'update', task_id: created.task.id, source_id: 'amie-task-82' });
  assert.equal(updated.task.source_id, 'amie-task-82');
  const read = (await readCalendarTasks(lists)).tasks.find(task => task.id === created.task.id);
  assert.deepEqual([read.source_id, read.source_url], ['amie-task-82', 'https://app.amie.so/tasks/81']);
  await assert.rejects(async () => await changeCalendarTask(lists, {
    action: 'update', task_id: created.task.id, source_url: 'javascript:alert(1)',
  }), /HTTP or HTTPS/);
  await assert.rejects(async () => await changeCalendarTask(lists, {
    action: 'update', task_id: created.task.id, source_id: 'x'.repeat(data.limits.source_id_chars + 1),
  }), /500 characters or fewer/);
});

test('Calendar task DATA works against the real in-memory Lists owner', async () => {
  const store = localStore(':memory:');
  const lists = makeLists({ eeaf: store.eeaf, newId: () => 'test-task' });
  const made = await changeCalendarTask(lists, { action: 'create', request_key: 'memory-owner', title: 'Read the brief', duration_minutes: 25, due: '2026-10-20' });
  assert.deepEqual((await lists.find(data.list.id)).fields.map(field => field.id), data.list.fields.map(field => field.id));
  assert.equal((await lists.row(data.list.id, made.task.id)).values.title, 'Read the brief');
  const scheduled = await changeCalendarTask(lists, { action: 'schedule', task_id: made.task.id, start: '2026-10-14T09:00:00Z', end: '2026-10-14T09:35:00Z' });
  assert.equal(scheduled.task.duration_minutes, 35);
  assert.equal((await readCalendarTasks(lists, { from: '2026-10-14T00:00:00Z', to: '2026-10-15T00:00:00Z' })).tasks[0].id, made.task.id);
  assert.equal((await changeCalendarTask(lists, { action: 'complete', task_id: made.task.id })).task.status, 'Done');
});

test('Calendar task DATA adds provenance fields to an existing Lists definition without replacing its rows', async () => {
  const store = localStore(':memory:');
  const lists = makeLists({ eeaf: store.eeaf, newId: () => 'legacy-task' });
  const legacy = { ...data.list, fields: data.list.fields.filter(field => !['source_id', 'source_url', 'collection_id'].includes(field.id))
    .map(field => field.id === 'parent_id' ? (({ link_constraints, ...rest }) => rest)(field) : field) };
  await lists.ensure(legacy, { actor: { by: 'test' } });
  await lists.putRows(data.list.id, { rows: [{ id: 'old', values: { title: 'Existing task', duration_minutes: 20 } }] }, { actor: { by: 'test' } });
  const answer = await readCalendarTasks(lists);
  assert.deepEqual((await lists.find(data.list.id)).fields.map(field => field.id), data.list.fields.map(field => field.id));
  assert.deepEqual((await lists.find(data.list.id)).fields.find(field => field.id === 'parent_id').link_constraints,
    { max_links: 1, require_target: true, acyclic: true }, 'calendar schema reconciliation installs the current parent rules');
  assert.equal(answer.tasks[0].title, 'Existing task');
  assert.equal(answer.tasks[0].source_id, null);
});

test('task lists use generic Lists rows for create, read, rename, move, duplicate and delete', async () => {
  const store = localStore(':memory:');
  const lists = makeLists({ eeaf: store.eeaf, newId: () => 'unused-list-row' });
  const created = await changeCalendarTask(lists, { action: 'create_collection', request_key: 'work', title: 'Work' });
  assert.deepEqual(created, { collection: { id: 'calendar-collection-work', title: 'Work', color: null, default_calendar: null, archived: false, ai_scheduling: null, preferred_times: null }, kept: false, undo: { action: 'delete_collection', collection_id: 'calendar-collection-work' } });
  assert.equal((await changeCalendarTask(lists, { action: 'create_collection', request_key: 'work', title: 'Work' })).kept, true,
    'retrying a collection create returns the same collection');
  await assert.rejects(async () => await changeCalendarTask(lists, { action: 'create_collection', request_key: 'work', title: 'Different' }), /different task list/);

  const task = await changeCalendarTask(lists, {
    action: 'create', request_key: 'work-task', title: 'Prepare the brief', duration_minutes: 30,
    collection_id: created.collection.id, labels: ['Client'],
  });
  assert.equal(task.task.collection_id, created.collection.id);
  const duplicate = await changeCalendarTask(lists, { action: 'duplicate', task_id: task.task.id, request_key: 'work-copy' });
  assert.equal(duplicate.task.collection_id, created.collection.id);
  assert.deepEqual(duplicate.task.labels, ['Client']);

  assert.deepEqual((await readCalendarTaskCollections(lists)).collections, [created.collection]);
  const renamed = await changeCalendarTask(lists, { action: 'update_collection', collection_id: created.collection.id, title: 'Projects' });
  assert.deepEqual(renamed.collection, { ...created.collection, title: 'Projects' });
  assert.equal((await readCalendarTasks(lists)).tasks.find(row => row.id === task.task.id).collection_id, created.collection.id);
  assert.equal((await changeCalendarTask(lists, { action: 'move', task_id: task.task.id, collection_id: null })).task.collection_id, null);
  assert.equal((await changeCalendarTask(lists, { action: 'move', task_id: duplicate.task.id, collection_id: null })).task.collection_id, null);

  await changeCalendarTask(lists, { action: 'move', task_id: task.task.id, collection_id: created.collection.id });
  await changeCalendarTask(lists, { action: 'move', task_id: duplicate.task.id, collection_id: created.collection.id });
  assert.deepEqual(await changeCalendarTask(lists, { action: 'delete_collection', collection_id: created.collection.id }), { id: created.collection.id, removed: true });
  assert.equal((await lists.row(data.list.id, task.task.id)).values.collection_id, undefined,
    'the Lists owner atomically detaches task links when their collection row is removed');
  assert.equal((await lists.row(data.list.id, duplicate.task.id)).values.collection_id, undefined);
  assert.deepEqual((await readCalendarTaskCollections(lists)).collections, []);
  await assert.rejects(async () => await changeCalendarTask(lists, { action: 'move', task_id: task.task.id, collection_id: created.collection.id }), /still exists/);
});

test('task reads expose bounded pages without imposing a total task limit', async () => {
  const lists = listsOwner();
  for (let index = 0; index < 2001; index += 1) {
    const id = `task-${String(index).padStart(4, '0')}`;
    lists.rows.set(id, { id, values: { title: `Task ${index}`, duration_minutes: 30, status: 'To do' } });
  }
  let cursor;
  let read = 0;
  let count = 0;
  do {
    const page = await readCalendarTasks(lists, { ...(cursor ? { cursor } : {}) });
    assert.ok(page.tasks.length <= 50, 'each read stays bounded');
    count += page.tasks.length;
    cursor = page.page.next_cursor;
    read += 1;
  } while (cursor);
  assert.equal(read, 41);
  assert.equal(count, 2001);
});

test('Calendar task parents are validated against the exact ancestor chain and detached on removal', async () => {
  const store = localStore(':memory:');
  const lists = makeLists({ eeaf: store.eeaf });
  const parent = await changeCalendarTask(lists, { action: 'create', request_key: 'parent', title: 'Parent', duration_minutes: 20 });
  const child = await changeCalendarTask(lists, { action: 'create', request_key: 'child', title: 'Child', duration_minutes: 10, parent_id: parent.task.id });
  assert.equal(child.task.parent_id, parent.task.id);
  await assert.rejects(async () => await changeCalendarTask(lists, { action: 'update', task_id: parent.task.id, parent_id: child.task.id }), /ancestor/);
  await assert.rejects(async () => await changeCalendarTask(lists, { action: 'update', task_id: child.task.id, parent_id: 'missing-task' }), /parent task is not/);
  await changeCalendarTask(lists, { action: 'delete', task_id: parent.task.id });
  assert.equal((await lists.row(data.list.id, child.task.id)).values.parent_id, undefined);
});

test('planning fields (deadline kind, earliest start, blockers, pin, who placed it) persist through the real Lists owner', async () => {
  const store = localStore(':memory:');
  let next = 0;
  const lists = makeLists({ eeaf: store.eeaf, newId: () => `row-${++next}` });
  const first = (await changeCalendarTask(lists, { action: 'create', request_key: 'first', title: 'First', duration_minutes: 60 })).task;
  const second = await changeCalendarTask(lists, {
    action: 'create', request_key: 'second', title: 'Second', duration_minutes: 30,
    deadline_type: 'soft', due: '2026-10-20', start_on: '2026-10-14', blocked_by: [first.id],
  });
  assert.deepEqual([second.task.deadline_type, second.task.start_on, second.task.blocked_by], ['soft', '2026-10-14', [first.id]]);
  assert.equal((await readCalendarTasks(lists)).tasks.find(task => task.id === second.task.id).blocked_by[0], first.id, 'a fresh read returns the stored blocker');
  assert.equal((await changeCalendarTask(lists, { action: 'create', request_key: 'second', title: 'Second', duration_minutes: 30,
    deadline_type: 'soft', due: '2026-10-20', start_on: '2026-10-14', blocked_by: [first.id] })).kept, true);
  await assert.rejects(async () => await changeCalendarTask(lists, { action: 'create', request_key: 'second', title: 'Second', duration_minutes: 30,
    deadline_type: 'hard', due: '2026-10-20', start_on: '2026-10-14', blocked_by: [first.id] }), /different task/);
  await assert.rejects(async () => await changeCalendarTask(lists, { action: 'update', task_id: second.task.id, deadline_type: 'whenever' }), /deadline kind/);
  await assert.rejects(async () => await changeCalendarTask(lists, { action: 'update', task_id: second.task.id, start_on: 'tomorrow-ish' }), /Start no earlier/);
  await assert.rejects(async () => await changeCalendarTask(lists, { action: 'update', task_id: second.task.id, blocked_by: [first.id, first.id] }), /wait for/);
  await assert.rejects(async () => await changeCalendarTask(lists, { action: 'update', task_id: first.id, blocked_by: [second.task.id] }), /./, 'two tasks cannot block each other');
  const cleared = (await changeCalendarTask(lists, { action: 'update', task_id: second.task.id, deadline_type: '', start_on: null, blocked_by: [] })).task;
  assert.deepEqual([cleared.deadline_type, cleared.start_on, cleared.blocked_by], [null, null, []]);

  // The planner places a task: it is the planner's. A person moving it pins it until its new end; unscheduling releases it.
  const placed = (await changeCalendarTask(lists, { action: 'schedule', task_id: first.id, start: '2026-10-14T09:00:00Z', placed_by: 'planner' })).task;
  assert.deepEqual([placed.auto_placed, placed.pinned_until], [true, null]);
  const moved = (await changeCalendarTask(lists, { action: 'schedule', task_id: first.id, start: '2026-10-14T13:00:00Z' })).task;
  assert.deepEqual([moved.auto_placed, moved.pinned_until], [true, '2026-10-14T14:00:00.000Z']);
  const replaced = (await changeCalendarTask(lists, { action: 'schedule', task_id: first.id, start: '2026-10-15T09:00:00Z', placed_by: 'planner' })).task;
  assert.equal(replaced.pinned_until, null, 'the planner placing it again lifts the pin');
  const unscheduled = (await changeCalendarTask(lists, { action: 'unschedule', task_id: first.id })).task;
  assert.deepEqual([unscheduled.auto_placed, unscheduled.pinned_until, unscheduled.starts_at], [false, null, null]);
  const manual = (await changeCalendarTask(lists, { action: 'schedule', task_id: second.task.id, start: '2026-10-16T09:00:00Z' })).task;
  assert.deepEqual([manual.auto_placed, manual.pinned_until], [false, null], 'a task a person scheduled is fixed, not pinned');
});

const realLists = () => {
  const store = localStore(':memory:');
  let next = 0;
  return makeLists({ eeaf: store.eeaf, newId: () => `row-${++next}` });
};
const stored = async (lists, id) => (await lists.row(data.list.id, id))?.values;

test('every change answers with the restore that undoes exactly it, and a restore refuses once the task has changed again', async () => {
  const lists = realLists();
  const made = await changeCalendarTask(lists, { action: 'create', request_key: 'undo', title: 'Write', duration_minutes: 30, due: '2026-10-20' });
  assert.deepEqual(made.undo, { action: 'restore', rows: [{ task_id: made.task.id, remove: true }] }, 'the way back from a create is to remove it');

  const scheduled = await changeCalendarTask(lists, { action: 'schedule', task_id: made.task.id, start: '2026-10-14T09:00:00Z', placed_by: 'planner' });
  assert.deepEqual(Object.keys(scheduled.undo.rows[0].values).sort(), ['ends_at', 'placed_by', 'starts_at']);
  assert.deepEqual(scheduled.undo.rows[0].values, { starts_at: null, ends_at: null, placed_by: null });
  const moved = await changeCalendarTask(lists, { action: 'schedule', task_id: made.task.id, start: '2026-10-14T13:00:00Z' });
  const back = await changeCalendarTask(lists, moved.undo);
  assert.equal(back.restored, 1);
  assert.equal((await stored(lists, made.task.id)).starts_at, '2026-10-14T09:00:00.000Z', 'undoing the move puts the planner\'s time back');
  assert.equal((await stored(lists, made.task.id)).pinned_until ?? null, null, 'and lifts the pin the move made');
  assert.deepEqual(back.undo.rows[0].values.starts_at, '2026-10-14T13:00:00.000Z', 'a restore can itself be undone');

  await changeCalendarTask(lists, { action: 'schedule', task_id: made.task.id, start: '2026-10-14T15:00:00Z' });
  await assert.rejects(async () => await changeCalendarTask(lists, scheduled.undo), /changed since/, 'the task is no longer as the schedule left it');
  assert.equal((await stored(lists, made.task.id)).starts_at, '2026-10-14T15:00:00.000Z', 'a refused restore writes nothing');

  const edited = await changeCalendarTask(lists, { action: 'update', task_id: made.task.id, title: 'Write the brief', priority: 'high', labels: ['Client'] });
  await changeCalendarTask(lists, edited.undo);
  assert.deepEqual([(await stored(lists, made.task.id)).title, (await stored(lists, made.task.id)).priority ?? null, (await stored(lists, made.task.id)).labels ?? []], ['Write', null, []]);

  const done = await changeCalendarTask(lists, { action: 'complete', task_id: made.task.id });
  await changeCalendarTask(lists, done.undo);
  assert.equal((await stored(lists, made.task.id)).status ?? 'To do', 'To do');

  const removed = await changeCalendarTask(lists, { action: 'delete', task_id: made.task.id });
  assert.equal(await lists.row(data.list.id, made.task.id), null);
  await changeCalendarTask(lists, removed.undo);
  assert.deepEqual([(await stored(lists, made.task.id)).title, (await stored(lists, made.task.id)).due, (await stored(lists, made.task.id)).duration_minutes], ['Write', '2026-10-20', 30], 'a deleted task comes back with its fields');
  await changeCalendarTask(lists, made.undo);
  assert.equal(await lists.row(data.list.id, made.task.id), null, 'undoing the create removes it');
  await assert.rejects(async () => await changeCalendarTask(lists, made.undo), /changed since/);
  await assert.rejects(async () => await changeCalendarTask(lists, { action: 'restore', rows: [{ task_id: 'calendar-ghost', create: { title: 'x', duration_minutes: 5, recurrence: '{}' } }] }), /Restore needs/, 'a repeat rule is never restored');
  await assert.rejects(async () => await changeCalendarTask(lists, { action: 'restore', rows: [] }), /Restore needs/);
});

test('a change that touches a repeat rule answers no undo, because restore never rewrites a series', async () => {
  const lists = realLists();
  const made = await changeCalendarTask(lists, { action: 'create', request_key: 'series', title: 'Weekly', duration_minutes: 30 });
  const repeating = await changeCalendarTask(lists, { action: 'update', task_id: made.task.id, recurrence: { frequency: 'week', interval: 1, weekdays: ['mon'], ends: { kind: 'never' } } });
  assert.equal(repeating.undo, undefined);
});

test('rollover clears yesterday\'s blocks, moves date-only dues to today, leaves the rest with a reason, and undoes as one', async () => {
  const lists = realLists();
  const make = async (key, extra = {}) => (await changeCalendarTask(lists, { action: 'create', request_key: key, title: key, duration_minutes: 30, ...extra })).task;
  const missed = await make('missed');
  await changeCalendarTask(lists, { action: 'schedule', task_id: missed.id, start: '2026-10-13T14:00:00Z', placed_by: 'planner' });
  const overdue = await make('overdue', { due: '2026-10-12' });
  const today = await make('today-block');
  await changeCalendarTask(lists, { action: 'schedule', task_id: today.id, start: '2026-10-14T14:00:00Z' });
  const timed = await make('timed', { due: '2026-10-12T09:00:00Z' });
  const finished = await make('finished', { due: '2026-10-01' });
  await changeCalendarTask(lists, { action: 'complete', task_id: finished.id });
  const future = await make('future', { due: '2026-10-30' });
  const result = await changeCalendarTask(lists, { action: 'rollover', today: '2026-10-14', time_zone: 'America/New_York', request_key: 'roll' });
  assert.deepEqual(result.carried.map(row => [row.task_id, row.cleared_block, row.due_to ?? null]).sort(), [[missed.id, true, null], [overdue.id, false, '2026-10-14']].sort());
  assert.deepEqual(Object.fromEntries(result.skipped.map(row => [row.task_id, row.reason])), {
    [today.id]: 'nothing_to_carry', [timed.id]: 'due_has_time_of_day', [future.id]: 'nothing_to_carry',
  });
  assert.deepEqual([(await stored(lists, missed.id)).starts_at ?? null, (await stored(lists, missed.id)).placed_by ?? null], [null, null], 'the missed block is gone and the task is unscheduled again');
  assert.equal((await stored(lists, overdue.id)).due, '2026-10-14');
  assert.equal((await stored(lists, today.id)).starts_at, '2026-10-14T14:00:00.000Z', 'today\'s block stays');
  assert.equal((await stored(lists, timed.id)).due, '2026-10-12T09:00:00Z', 'a due with a time of day is a commitment and is left');

  const again = await changeCalendarTask(lists, { action: 'rollover', today: '2026-10-14', time_zone: 'America/New_York', request_key: 'roll' });
  assert.deepEqual(again.carried, [], 'rolling over twice carries nothing the second time');

  await changeCalendarTask(lists, result.undo);
  assert.equal((await stored(lists, missed.id)).starts_at, '2026-10-13T14:00:00.000Z');
  assert.equal((await stored(lists, missed.id)).placed_by, 'planner');
  assert.equal((await stored(lists, overdue.id)).due, '2026-10-12', 'one undo puts every carried task back');
  const named = await changeCalendarTask(lists, { action: 'rollover', today: '2026-10-14', time_zone: 'America/New_York', task_ids: [overdue.id] });
  assert.deepEqual(named.carried.map(row => row.task_id), [overdue.id]);
  assert.equal((await stored(lists, missed.id)).starts_at, '2026-10-13T14:00:00.000Z', 'only the named task was carried');
  await assert.rejects(async () => await changeCalendarTask(lists, { action: 'rollover', today: 'yesterday', time_zone: 'America/New_York' }), /time zone/);
  await assert.rejects(async () => await changeCalendarTask(lists, { action: 'rollover', today: '2026-10-14', time_zone: 'Mars/Base' }), /time zone/);
});

test('the Calendar tasks route answers rollover and restore the same way the action does', async () => {
  const lists = realLists();
  const post = body => handleCalendarTasksRequest(lists, new Request('https://x/calendar/tasks', { method: 'POST', body: JSON.stringify(body) })).then(response => response.json());
  const made = await post({ action: 'create', request_key: 'http', title: 'Over the wire', duration_minutes: 20, due: '2026-10-01' });
  const rolled = await post({ action: 'rollover', today: '2026-10-14', time_zone: 'UTC' });
  assert.equal(rolled.carried.length, 1);
  assert.equal((await stored(lists, made.task.id)).due, '2026-10-14');
  assert.equal((await post(rolled.undo)).restored, 1);
  assert.equal((await stored(lists, made.task.id)).due, '2026-10-01');
});

test('day hours are set, read back for the planner, undone and cleared as stored rows, and bad hours are refused', async () => {
  const lists = realLists();
  const set = await changeCalendarTask(lists, { action: 'set_day_hours', day: '2026-10-14', start_minute: 13 * 60, blocks: [{ start_minute: 15 * 60, end_minute: 16 * 60 }] });
  assert.deepEqual(set.day_hours, { day: '2026-10-14', start_minute: 780, blocks: [{ start_minute: 900, end_minute: 960 }] });
  assert.deepEqual(set.undo, { action: 'clear_day_hours', day: '2026-10-14' }, 'the way back from a first change is to clear it');
  const off = await changeCalendarTask(lists, { action: 'set_day_hours', day: '2026-10-15', off: true });
  assert.deepEqual(off.day_hours, { day: '2026-10-15', off: true });
  const replaced = await changeCalendarTask(lists, { action: 'set_day_hours', day: '2026-10-14', end_minute: 12 * 60 });
  assert.deepEqual(replaced.day_hours, { day: '2026-10-14', end_minute: 720 }, 'setting a day again replaces its hours');
  assert.deepEqual(replaced.undo, { action: 'set_day_hours', day: '2026-10-14', start_minute: 780, blocks: [{ start_minute: 900, end_minute: 960 }] });

  const read = await readCalendarTasks(lists, { from: '2026-10-13T00:00:00Z', to: '2026-10-20T00:00:00Z' });
  assert.deepEqual(read.day_hours.map(row => row.day), ['2026-10-14', '2026-10-15']);
  assert.deepEqual((await readCalendarTasks(lists, { from: '2026-12-01T00:00:00Z', to: '2026-12-08T00:00:00Z' })).day_hours, [], 'only days near the window are read');

  // The planner reads exactly what is stored.
  const plan = planSchedule([{ id: 'one', title: 'one', duration_minutes: 60 }], [], {
    start_day: '2026-10-14', horizon_days: 2, working_hours: { start_minute: 540, end_minute: 1020, weekdays: [0, 1, 2, 3, 4, 5, 6] }, day_overrides: read.day_hours,
  });
  assert.equal(new Date(plan.proposals[0].starts_at).getHours(), 9, 'the 12:00 stop leaves the morning of the 14th open');
  const cleared = await changeCalendarTask(lists, replaced.undo);
  assert.deepEqual(cleared.day_hours, { day: '2026-10-14', start_minute: 780, blocks: [{ start_minute: 900, end_minute: 960 }] });
  assert.deepEqual((await changeCalendarTask(lists, { action: 'clear_day_hours', day: '2026-10-14' })).undo.action, 'set_day_hours');
  assert.deepEqual(await changeCalendarTask(lists, { action: 'clear_day_hours', day: '2026-10-14' }), { day: '2026-10-14', removed: false });
  for (const bad of [{ day: '2026-10-14' }, { day: 'soon', off: true }, { day: '2026-10-14', start_minute: 900, end_minute: 600 }, { day: '2026-10-14', blocks: [{ start_minute: 5, end_minute: 5 }] }, { day: '2026-10-14', off: 'yes' }]) {
    await assert.rejects(async () => await changeCalendarTask(lists, { action: 'set_day_hours', ...bad }), /Day hours need/, JSON.stringify(bad));
  }
});

test('working hours are set, read back, undone and cleared, and the quiet-hours answer follows them and the person\'s mode', async () => {
  const lists = realLists();
  const now = () => Date.parse('2026-10-14T23:30:00Z');
  assert.equal((await changeCalendarTask(lists, { action: 'quiet_hours' }, { now })).quiet, false, 'no working hours set: never quiet');
  const set = await changeCalendarTask(lists, { action: 'set_working_hours', start: '09:00', end: '17:00', time_zone: 'America/New_York', weekdays: [1, 2, 3, 4, 5] });
  assert.deepEqual(set.working_hours, { start: '09:00', end: '17:00', time_zone: 'America/New_York', weekdays: [1, 2, 3, 4, 5], mode: 'nudge' });
  assert.deepEqual(set.undo, { action: 'clear_working_hours' });
  assert.deepEqual((await readCalendarTasks(lists)).working_hours, set.working_hours);
  const night = await changeCalendarTask(lists, { action: 'quiet_hours' }, { now });
  assert.deepEqual([night.quiet, night.nudge, night.send_silently], [true, true, false]);
  assert.equal((await changeCalendarTask(lists, { action: 'quiet_hours', dismissed_period_start_ms: night.period_start_ms }, { now })).nudge, false, 'dismissed for this quiet period');
  assert.equal((await changeCalendarTask(lists, { action: 'quiet_hours', at: '2026-10-14T14:00:00Z' })).quiet, false, 'asking about another moment');
  const silent = await changeCalendarTask(lists, { action: 'set_working_hours', start: '09:00', end: '17:00', time_zone: 'America/New_York', weekdays: [1, 2, 3, 4, 5], mode: 'auto_silent' });
  assert.equal((await changeCalendarTask(lists, { action: 'quiet_hours' }, { now })).send_silently, true);
  await changeCalendarTask(lists, silent.undo);
  assert.equal((await readCalendarTasks(lists)).working_hours.mode, 'nudge');
  assert.equal((await changeCalendarTask(lists, { action: 'clear_working_hours' })).removed, true);
  assert.equal((await readCalendarTasks(lists)).working_hours, null);
  for (const bad of [{ start: '9am' }, { time_zone: 'Mars/Base' }, { weekdays: [] }, { mode: 'loud' }]) {
    await assert.rejects(async () => await changeCalendarTask(lists, { action: 'set_working_hours', start: '09:00', end: '17:00', time_zone: 'UTC', ...bad }), /Working hours need/, JSON.stringify(bad));
  }
});

test('a task placed in slices becomes child tasks the planner placed, retries safely, and one undo removes the slices', async () => {
  const lists = realLists();
  const long = (await changeCalendarTask(lists, { action: 'create', request_key: 'long', title: 'Write the report', duration_minutes: 150, minimum_duration_minutes: 60, priority: 'high' })).task;
  assert.equal(long.minimum_duration_minutes, 60);
  await assert.rejects(async () => await changeCalendarTask(lists, { action: 'update', task_id: long.id, minimum_duration_minutes: 2 }), /smallest useful slice/);
  const slices = [{ start: '2026-10-12T13:00:00Z', end: '2026-10-12T14:00:00Z' }, { start: '2026-10-12T17:00:00Z', end: '2026-10-12T18:30:00Z' }];
  const placed = await changeCalendarTask(lists, { action: 'schedule_slices', task_id: long.id, slices });
  assert.deepEqual(placed.tasks.map(task => [task.title, task.duration_minutes, task.parent_id, task.slice_of, task.auto_placed, task.priority]), [
    ['Write the report (1/2)', 60, long.id, long.id, true, 'high'], ['Write the report (2/2)', 90, long.id, long.id, true, 'high'],
  ]);
  assert.equal((await stored(lists, long.id)).starts_at ?? null, null, 'the task keeps its whole length and is not itself scheduled');
  assert.equal((await changeCalendarTask(lists, { action: 'schedule_slices', task_id: long.id, slices })).kept, true, 'a retry answers the same slices');
  await assert.rejects(async () => await changeCalendarTask(lists, { action: 'schedule_slices', task_id: long.id, slices: [{ start: '2026-10-12T12:00:00Z', end: '2026-10-12T13:00:00Z' }, slices[1]] }), /different times/);
  for (const bad of [[], [slices[0]], [slices[1], slices[0]], [{ start: 'x', end: 'y' }, slices[1]]]) {
    await assert.rejects(async () => await changeCalendarTask(lists, { action: 'schedule_slices', task_id: 'calendar-long', slices: bad }), /Slices are/, JSON.stringify(bad));
  }
  const back = await changeCalendarTask(lists, placed.undo);
  assert.equal(back.restored, 2);
  assert.equal(await lists.row(data.list.id, `${long.id}-slice-1`), null);
});

test('a device zone that differs from the zone plans are kept in is asked about once, and moving or keeping is remembered', async () => {
  const lists = realLists();
  assert.deepEqual(await changeCalendarTask(lists, { action: 'zone_drift', device_zone: 'Europe/London' }), { planning_zone: null, device_zone: 'Europe/London', drifted: false, ask: false }, 'no working hours, no planning zone yet');
  await changeCalendarTask(lists, { action: 'set_working_hours', start: '09:00', end: '17:00', time_zone: 'America/New_York' });
  assert.equal((await changeCalendarTask(lists, { action: 'zone_drift', device_zone: 'America/New_York' })).ask, false);
  assert.equal((await changeCalendarTask(lists, { action: 'zone_drift', device_zone: 'Europe/London' })).ask, true);
  const kept = await changeCalendarTask(lists, { action: 'answer_zone_drift', device_zone: 'Europe/London', move: false });
  assert.equal(kept.working_hours.time_zone, 'America/New_York');
  assert.equal((await changeCalendarTask(lists, { action: 'zone_drift', device_zone: 'Europe/London' })).ask, false, 'a kept zone is not asked again');
  assert.equal((await readCalendarTasks(lists)).working_hours.time_zone, 'America/New_York');
  const moved = await changeCalendarTask(lists, { action: 'answer_zone_drift', device_zone: 'Asia/Tokyo', move: true });
  assert.equal(moved.working_hours.time_zone, 'Asia/Tokyo');
  assert.equal((await changeCalendarTask(lists, { action: 'zone_drift', device_zone: 'Asia/Tokyo' })).drifted, false);
  await changeCalendarTask(lists, moved.undo);
  assert.equal((await readCalendarTasks(lists)).working_hours.time_zone, 'America/New_York', 'moving can be undone');
  await changeCalendarTask(lists, { action: 'set_working_hours', start: '08:00', end: '16:00', time_zone: 'America/New_York' });
  assert.equal((await changeCalendarTask(lists, { action: 'zone_drift', device_zone: 'Europe/London' })).ask, false, 'editing the hours keeps what was already answered');
  await assert.rejects(async () => await changeCalendarTask(lists, { action: 'zone_drift', device_zone: 'nowhere' }), /Zone drift needs/);
  await assert.rejects(async () => await changeCalendarTask(lists, { action: 'answer_zone_drift', device_zone: 'Asia/Tokyo' }), /Zone drift needs/);
});

test('an event is pulled into the tasks once, unless a default filter refuses it; the filters are rows the caller may replace', async () => {
  const lists = realLists();
  const event = (extra = {}) => ({ id: 'ev1', source: 'google-calendar', title: 'Design review', starts_at: '2026-10-14T15:00:00Z', ends_at: '2026-10-14T16:00:00Z', attendee_count: 4, ...extra });
  const pulled = await changeCalendarTask(lists, { action: 'from_event', event: event() });
  assert.equal(pulled.pulled, true);
  assert.deepEqual([pulled.task.title, pulled.task.duration_minutes, pulled.task.starts_at, pulled.task.source_id, pulled.task.auto_placed], ['Design review', 60, '2026-10-14T15:00:00.000Z', 'google-calendar:ev1', false]);
  const again = await changeCalendarTask(lists, { action: 'from_event', event: event({ title: 'Renamed upstream' }) });
  assert.deepEqual([again.kept, again.task.id], [true, pulled.task.id], 'an event already linked is never pulled twice');
  for (const [filter, extra] of [['declined', { response: 'declined' }], ['focus_time', { event_kind: 'focusTime' }], ['solo', { attendee_count: 1 }], ['transparent', { transparency: 'transparent' }],
    ['hold', { title: 'Hold for offsite' }], ['unconfirmed', { status: 'tentative' }], ['multi_day_all_day', { all_day_days: 3 }], ['cancelled', { status: 'cancelled' }]]) {
    assert.deepEqual(await changeCalendarTask(lists, { action: 'from_event', event: event({ id: `x-${filter}`, ...extra }) }), { pulled: false, refused: [filter] }, filter);
  }
  assert.equal((await changeCalendarTask(lists, { action: 'from_event', event: event({ id: 'solo-ok', attendee_count: 1 }), filters: ['declined'] })).pulled, true, 'a caller naming its own filters replaces the defaults');
  assert.equal((await changeCalendarTask(lists, { action: 'from_event', event: event({ id: 'no-count', attendee_count: undefined }) })).pulled, true, 'an event with no attendee count is not called solo');
  assert.deepEqual(await changeCalendarTask(lists, { action: 'from_event', event: event({ id: 'long', ends_at: '2026-10-16T16:00:00Z' }) }), { pulled: false, refused: ['longer_than_a_day'] });
  await changeCalendarTask(lists, pulled.undo);
  assert.equal(await lists.row(data.list.id, pulled.task.id), null, 'undo removes the pulled task');
  await assert.rejects(async () => await changeCalendarTask(lists, { action: 'from_event', event: { id: 'a' } }), /An event to pull in needs/);
  await assert.rejects(async () => await changeCalendarTask(lists, { action: 'from_event', event: event(), filters: ['mood'] }), /Filters name/);
});

test('when a person chooses it, moving a task over planner-placed tasks takes those off the calendar with one undo; pinned and person-placed tasks stay', async () => {
  const lists = realLists();
  const now = () => Date.parse('2026-10-14T00:00:00Z');
  const make = async (key, minutes = 60) => (await changeCalendarTask(lists, { action: 'create', request_key: key, title: key, duration_minutes: minutes })).task;
  const planned = await make('planned'), pinned = await make('pinned'), mine = await make('mine'), mover = await make('mover');
  await changeCalendarTask(lists, { action: 'schedule', task_id: planned.id, start: '2026-10-14T13:00:00Z', placed_by: 'planner' });
  await changeCalendarTask(lists, { action: 'schedule', task_id: pinned.id, start: '2026-10-14T13:30:00Z', placed_by: 'planner' });
  await changeCalendarTask(lists, { action: 'update', task_id: pinned.id, pinned_until: '2026-10-14T14:30:00Z' });
  await changeCalendarTask(lists, { action: 'schedule', task_id: mine.id, start: '2026-10-14T13:00:00Z' });
  const off = await changeCalendarTask(lists, { action: 'schedule', task_id: mover.id, start: '2026-10-14T13:15:00Z' }, { now });
  assert.equal(off.displaced, undefined, 'by default nothing is moved');
  await changeCalendarTask(lists, off.undo);
  assert.equal((await changeCalendarTask(lists, { action: 'set_preferences', refit_on_move: true })).preferences.refit_on_move, true);
  assert.equal((await readCalendarTasks(lists)).preferences.refit_on_move, true);
  const moved = await changeCalendarTask(lists, { action: 'schedule', task_id: mover.id, start: '2026-10-14T13:15:00Z' }, { now });
  assert.deepEqual(moved.displaced, [planned.id]);
  assert.equal((await stored(lists, planned.id)).starts_at ?? null, null);
  assert.equal((await stored(lists, pinned.id)).starts_at, '2026-10-14T13:30:00.000Z', 'a pinned task stays');
  assert.equal((await stored(lists, mine.id)).starts_at, '2026-10-14T13:00:00.000Z', 'a task the person placed stays');
  await changeCalendarTask(lists, moved.undo);
  assert.equal((await stored(lists, planned.id)).starts_at, '2026-10-14T13:00:00.000Z');
  assert.equal((await stored(lists, planned.id)).placed_by, 'planner');
  assert.equal((await stored(lists, mover.id)).starts_at ?? null, null, 'one undo puts the moved task and the displaced one back');
  assert.equal((await changeCalendarTask(lists, { action: 'set_preferences', refit_on_move: false })).preferences.refit_on_move, false);
  await assert.rejects(async () => await changeCalendarTask(lists, { action: 'set_preferences', refit_on_move: 'yes' }), /planning preference/);
  assert.equal((await changeCalendarTask(lists, { action: 'quiet_hours' })).quiet, false, 'a preference alone is not working hours');
});

test('a bulk repair applies one DATA-row change to many tasks, lists what could not take it, and has one undo', async () => {
  const lists = realLists();
  const make = async (key, extra = {}) => (await changeCalendarTask(lists, { action: 'create', request_key: key, title: key, duration_minutes: 30, ...extra })).task;
  const one = await make('one'), two = await make('two'), three = await make('three');
  const high = await changeCalendarTask(lists, { action: 'bulk', repair: 'make_high_priority', task_ids: [one.id, two.id, 'calendar-missing'] });
  assert.deepEqual(high.changed, [one.id, two.id]);
  assert.equal(high.refused.length, 1);
  assert.equal(high.refused[0].task_id, 'calendar-missing');
  assert.equal((await stored(lists, one.id)).priority, 'high');
  assert.equal((await stored(lists, two.id)).priority, 'high');
  assert.notEqual((await stored(lists, three.id)).priority, 'high', 'a task not named is left alone');
  await changeCalendarTask(lists, high.undo);
  assert.notEqual((await stored(lists, one.id)).priority, 'high');
  assert.notEqual((await stored(lists, two.id)).priority, 'high', 'one undo takes back all that changed');
  const firm = await changeCalendarTask(lists, { action: 'bulk', repair: 'make_deadlines_firm', task_ids: [one.id, three.id] });
  assert.equal((await stored(lists, three.id)).deadline_type, 'hard');
  const done = await changeCalendarTask(lists, { action: 'bulk', repair: 'complete', task_ids: [one.id, three.id] });
  assert.equal((await stored(lists, one.id)).status, 'Done');
  await changeCalendarTask(lists, done.undo);
  assert.notEqual((await stored(lists, one.id)).status, 'Done');
  const removed = await changeCalendarTask(lists, { action: 'bulk', repair: 'remove', task_ids: [two.id] });
  assert.equal(await lists.row(data.list.id, two.id), null);
  await changeCalendarTask(lists, removed.undo);
  assert.equal((await stored(lists, two.id)).title, 'two', 'a removed task comes back with its undo');
  assert.ok(firm.changed.length === 2);
  await assert.rejects(async () => await changeCalendarTask(lists, { action: 'bulk', repair: 'nope', task_ids: [one.id] }), /Choose a repair/);
  await assert.rejects(async () => await changeCalendarTask(lists, { action: 'bulk', repair: 'complete', task_ids: [] }), /Choose a repair/);
});

test('daily capacity is stored, read back with the tasks, refused when malformed, and has an undo', async () => {
  const lists = realLists();
  assert.equal((await readCalendarTasks(lists)).capacity, null);
  const set = await changeCalendarTask(lists, { action: 'set_capacity', default_minutes: 360, caution_band_minutes: 60, weekdays: { 5: 240 } });
  assert.deepEqual((await readCalendarTasks(lists)).capacity, { default_minutes: 360, caution_band_minutes: 60, weekdays: { 5: 240 } });
  await assert.rejects(async () => await changeCalendarTask(lists, { action: 'set_capacity', default_minutes: 5000 }), /most minutes/);
  await assert.rejects(async () => await changeCalendarTask(lists, { action: 'set_capacity', default_minutes: 60, weekdays: { 9: 10 } }), /most minutes/);
  await changeCalendarTask(lists, set.undo);
  assert.equal((await readCalendarTasks(lists)).capacity, null, 'the undo of the first setting is no limit');
  assert.equal((await changeCalendarTask(lists, { action: 'set_capacity' })).capacity, null);
});

test('the calendar display choice is off until chosen, takes only a listed row, and has an undo', async () => {
  const lists = realLists();
  assert.equal((await readCalendarTasks(lists)).preferences.external_display, 'off');
  const set = await changeCalendarTask(lists, { action: 'set_preferences', external_display: 'busy_when_at_risk' });
  assert.equal((await readCalendarTasks(lists)).preferences.external_display, 'busy_when_at_risk');
  await assert.rejects(async () => await changeCalendarTask(lists, { action: 'set_preferences', external_display: 'loud' }), /planning preference/);
  await changeCalendarTask(lists, set.undo);
  assert.equal((await readCalendarTasks(lists)).preferences.external_display, 'off');
});

test('clearing working hours keeps the planning choices and the daily limit stored beside them', async () => {
  const lists = realLists();
  await changeCalendarTask(lists, { action: 'set_preferences', refit_on_move: true });
  await changeCalendarTask(lists, { action: 'set_capacity', default_minutes: 300 });
  const set = await changeCalendarTask(lists, { action: 'set_working_hours', start: '09:00', end: '17:00', time_zone: 'UTC', mode: 'auto_silent' });
  const cleared = await changeCalendarTask(lists, { action: 'clear_working_hours' });
  assert.equal(cleared.removed, true);
  const read = await readCalendarTasks(lists);
  assert.equal(read.working_hours, null);
  assert.equal(read.preferences.refit_on_move, true);
  assert.equal(read.capacity.default_minutes, 300);
  await changeCalendarTask(lists, cleared.undo);
  assert.equal((await readCalendarTasks(lists)).working_hours.mode, 'auto_silent');
  assert.equal((await changeCalendarTask(lists, set.undo)).removed, true);
});

test('silentAt is true only outside working hours and only when the person chose to be written to without a push', async () => {
  const lists = realLists();
  const night = Date.parse('2036-10-07T03:00:00Z');
  assert.equal(await silentAt(lists, night), false, 'no hours set');
  await changeCalendarTask(lists, { action: 'set_working_hours', start: '09:00', end: '17:00', time_zone: 'America/New_York', weekdays: [1, 2, 3, 4, 5], mode: 'auto_silent' });
  assert.equal(await silentAt(lists, night), true);
  assert.equal(await silentAt(lists, Date.parse('2036-10-07T15:00:00Z')), false, 'working');
  await changeCalendarTask(lists, { action: 'set_working_hours', start: '09:00', end: '17:00', time_zone: 'America/New_York', weekdays: [1, 2, 3, 4, 5], mode: 'nudge' });
  assert.equal(await silentAt(lists, night), false, 'nudge mode does not silence the recipient');
});

test('a task for a source is made once and found again; find_source never makes one', async () => {
  const lists = realLists();
  assert.equal((await changeCalendarTask(lists, { action: 'find_source', source_id: 'gmail:c1:m1' })).task, null);
  const made = await changeCalendarTask(lists, { action: 'from_source', source_id: 'gmail:c1:m1', title: 'Pay the deposit', source_url: 'https://mail.google.com/x' });
  assert.deepEqual([made.kept, made.task.title, made.task.duration_minutes, made.task.source_id], [false, 'Pay the deposit', 30, 'gmail:c1:m1']);
  const again = await changeCalendarTask(lists, { action: 'from_source', source_id: 'gmail:c1:m1', title: 'Another title' });
  assert.deepEqual([again.kept, again.task.id, again.task.title], [true, made.task.id, 'Pay the deposit']);
  assert.equal((await changeCalendarTask(lists, { action: 'find_source', source_id: 'gmail:c1:m1' })).task.id, made.task.id);
  assert.equal((await changeCalendarTask(lists, { action: 'from_source', source_id: 'gmail:c1:m2', title: 'Other' })).task.id !== made.task.id, true);
  await assert.rejects(async () => await changeCalendarTask(lists, { action: 'from_source', source_id: '', title: 'x' }), /needs its source id/);
});

function setStatusChoices(lists, { choices, starts, settles }) {
  const field = lists.definitions.get(data.list.id).fields.find(item => item.id === 'status');
  Object.assign(field, { choices, starts, settles });
}

test('a settled status is the one the list field names, not a constant in code', async () => {
  const lists = listsOwner();
  setStatusChoices(lists, { choices: ['To do', 'Shipped'], starts: 'To do', settles: ['Shipped'] });
  const made = await changeCalendarTask(lists, { action: 'create', request_key: 'shipped-1', title: 'Ship the build', duration_minutes: 20 });
  assert.equal(made.task.status, 'To do');
  assert.equal(made.task.may_move, true);
  const completed = await changeCalendarTask(lists, { action: 'complete', task_id: made.task.id });
  assert.equal(completed.task.status, 'Shipped', 'complete writes the first settled choice of the field');
  assert.equal(completed.task.may_move, false, 'a task settled by a renamed choice is not movable');
  await assert.rejects(changeCalendarTask(lists, { action: 'schedule', task_id: made.task.id, start: '2026-10-14T10:00:00Z' }), /cannot be scheduled/);
  const reopened = await changeCalendarTask(lists, { action: 'reopen', task_id: made.task.id });
  assert.equal(reopened.task.status, 'To do', 'reopen clears the status to the field starting choice');
});

test('a status that is not in settles is open, even when it is named Done', async () => {
  const lists = listsOwner();
  setStatusChoices(lists, { choices: ['To do', 'Done', 'Shipped'], starts: 'To do', settles: ['Shipped'] });
  lists.rows.set('done-open', { id: 'done-open', values: { title: 'Old label', duration_minutes: 30, status: 'Done' } });
  const task = await readCalendarTasks(lists, {});
  const row = task.tasks.find(item => item.id === 'done-open');
  assert.equal(row.status, 'Done');
  assert.equal(row.may_move, true, 'Done is open when the field does not settle it');
});

test('a starting choice renamed by the list is the status of a new task', async () => {
  const lists = listsOwner();
  setStatusChoices(lists, { choices: ['Not started', 'Finished'], starts: 'Not started', settles: ['Finished'] });
  const made = await changeCalendarTask(lists, { action: 'create', request_key: 'renamed-start', title: 'Draft the note', duration_minutes: 10 });
  assert.equal(made.task.status, 'Not started');
  assert.equal(made.task.may_move, true);
});

test('a status field with a settled choice the field does not offer is refused, not guessed', async () => {
  const lists = listsOwner();
  setStatusChoices(lists, { choices: ['To do', 'Done'], starts: 'To do', settles: ['Shipped'] });
  await assert.rejects(changeCalendarTask(lists, { action: 'create', request_key: 'bad-rule', title: 'Anything', duration_minutes: 10 }), /settled choice/);
});

test('a list that holds its own status choices keeps them when the shipped shape is applied again', async () => {
  const lists = listsOwner();
  const five = ['To do', 'In progress', 'Waiting', 'Blocked', 'Done'];
  setStatusChoices(lists, { choices: five, starts: 'To do', settles: ['Done'] });
  await readCalendarTasks(lists, {});
  const field = lists.definitions.get(data.list.id).fields.find(item => item.id === 'status');
  assert.deepEqual(field.choices, five, 'the shipped two-choice shape does not overwrite the choices the person set');
  assert.deepEqual(field.settles, ['Done']);
  lists.rows.set('five-blocked', { id: 'five-blocked', values: { title: 'Blocked item', duration_minutes: 10, status: 'Blocked' } });
  lists.rows.set('five-done', { id: 'five-done', values: { title: 'Finished item', duration_minutes: 10, status: 'Done' } });
  const page = await readCalendarTasks(lists, {});
  assert.equal(page.tasks.find(task => task.id === 'five-blocked').may_move, true, 'Blocked is open: only Done settles this list');
  assert.equal(page.tasks.find(task => task.id === 'five-done').may_move, false, 'Done settles this list');
});

