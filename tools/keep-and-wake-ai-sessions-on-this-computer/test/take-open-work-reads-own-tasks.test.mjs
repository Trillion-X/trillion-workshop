// A pass of take-open-work over a store that keeps the tasks as rows reads only the tasks this worker may act on, filtered
// by the store (take-open-work.mjs invariant 8), not every open task. A real Postgres (PGlite) keeps 3,000+ open tasks handed
// to other agents or to nobody; the worker's own assigned, held, resumable, turn and declared-shape tasks are still found,
// and the statements a pass sends grow with those tasks, not with the thousands. All records are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { listOpenWork, takesUnassigned, takerCard, taskCaller, tasksThisWorkerMayTake } from '../harness/take-open-work.mjs';
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import base from '../harness/take-open-work.json' with { type: 'json' };

const NOW = new Date('2026-11-24T08:00:00.000Z');
const ENGINE_STEPS = [{ 'told_as.source': ['workflow-step-answered'], for: ['anyone', 'ai'], 'asks.submit': true, 'asks.checks': false }];
const settingsFor = (take_unassigned_when = []) => ({ ...base, computer_name: 'Reads Fixture', tasks_store: 'tasks-store', state_folder: tempFolder(join(tmpdir(), 'reads-own-tasks-')), working_folder: tmpdir(),
  triage: undefined, work_mcp: undefined, tasks: { ...base.tasks, take_unassigned_when } });
const meOf = settings => `ai:${takerCard(settings, 'Fixture').agent_id}`;

async function store() {
  const db = new PGlite();
  await db.exec(`create table calendar_tasks (id text primary key, title text, description text, status text, priority text, assignees jsonb,
    sent_by text, sent_at text, taken_by text, taken_at text, finished_by text, finished_at text, outcome text, result text, summary text,
    details jsonb, plain_title text, made_at timestamptz, changed_at timestamptz);`);
  const statements = [];
  const resource = async (address, method, input) => {
    assert.equal(method, 'tools:run', `${method} at ${address} is not an operation this fixture serves`);
    statements.push(input.input.sql);
    const answer = await db.query(input.input.sql, input.input.params);
    return { exit_code: 0, result: { rows: answer.rows } };
  };
  const add = (id, status, { assignees = [], taken_by = null, sent_by = null, details = {} } = {}) => db.query(
    'insert into calendar_tasks (id, title, status, assignees, taken_by, sent_by, details) values ($1, $1, $2, $3::jsonb, $4, $5, $6::jsonb)', [id, status, JSON.stringify(assignees), taken_by, sent_by, JSON.stringify(details)]);
  const caller = settings => taskCaller(Object.assign(async () => { throw new Error('no legacy HTTP here'); }, { resource }), settings, { now: () => NOW, computer: 'Fixture' });
  return { db, add, statements, caller };
}

async function crowd(db, others) {
  // 2,000 handed to nobody, 700 to other named agents, 300 in progress under other agents: 3,000 tasks, none for this worker.
  await db.query(`insert into calendar_tasks (id, title, status, assignees, details)
    select 'calendar-task:nobody-' || g, 'n', 'To do', '[]'::jsonb, '{"for": "person"}'::jsonb from generate_series(1, 2000) g`);
  await db.query(`insert into calendar_tasks (id, title, status, assignees, details)
    select 'calendar-task:named-' || g, 'n', 'To do', jsonb_build_array($1::text || g), '{}'::jsonb from generate_series(1, 700) g`, [others]);
  await db.query(`insert into calendar_tasks (id, title, status, assignees, taken_by, details)
    select 'calendar-task:busy-' || g, 'n', 'In progress', jsonb_build_array($1::text || g), $1::text || g, '{}'::jsonb from generate_series(1, 300) g`, [others]);
}

const step = (extra = {}) => ({ told_as: { source: 'workflow-step-answered' }, for: 'anyone', asks: { do: 'Say ready', submit: { type: 'object' }, checks: [] }, ...extra });

test('a pass over 3,000 open tasks handed to others reads only this worker\'s own tasks, in a few statements', async () => {
  const settings = settingsFor();
  const me = meOf(settings);
  const { db, add, statements, caller } = await store();
  await crowd(db, 'ai:someone-else-');
  await add('calendar-task:assigned-1', 'To do', { assignees: [me] });
  await add('calendar-task:assigned-2', 'To do', { assignees: ['ai:another', me] });
  await add('calendar-task:held', 'In progress', { assignees: [me], taken_by: me });
  await add('calendar-task:held-unnamed', 'In progress', { taken_by: me });
  await add('calendar-task:parked', 'Waiting', { assignees: [me], details: { continuation: { owner: me, after: '2026-11-25T08:00:00.000Z' } } });
  await add('calendar-task:turn', 'To do', { details: { source: { kind: 'chat', ref: 'claude-code:abc' } } });

  const { work } = await listOpenWork(caller(settings));
  assert.deepEqual(work.map(task => task.handoff_id).sort(), ['calendar-task:assigned-1', 'calendar-task:assigned-2', 'calendar-task:held', 'calendar-task:held-unnamed', 'calendar-task:parked', 'calendar-task:turn']);
  assert.ok(statements.length <= 8, `${statements.length} statements for 6 own tasks among 3,006`);
  assert.ok(statements.every(sql => /where /.test(sql) && /@>/.test(sql)), 'every read is filtered by the store');

  // The same pass without the filter reads all of them a page at a time: the crowd is large enough to show the difference.
  const unfiltered = [];
  let after = null;
  do {
    const sql = `select id from calendar_tasks where status = $1 ${after ? 'and id > $2' : ''} order by id limit 101`;
    const rows = (await db.query(sql, after ? ['To do', after] : ['To do'])).rows;
    unfiltered.push(rows.length);
    after = rows.length > 100 ? rows[99].id : null;
  } while (after);
  assert.ok(unfiltered.length >= 20, `${unfiltered.length} pages without the filter`);
});

test('tasks that name nobody are read only when a shape of tasks.take_unassigned_when fits them (and the shipped list reads none)', async () => {
  const shipped = settingsFor();
  assert.deepEqual(base.tasks.take_unassigned_when, []);
  const { db, add, caller } = await store();
  await crowd(db, 'ai:someone-else-');
  await add('calendar-task:step-a', 'To do', { details: step() });
  await add('calendar-task:step-b', 'To do', { details: step({ for: 'ai' }) });
  await add('calendar-task:step-checked', 'To do', { details: step({ asks: { do: 'x', submit: { type: 'object' }, checks: [{ id: 'c' }] } }) });
  await add('calendar-task:step-person', 'To do', { details: step({ for: 'person' }) });
  await add('calendar-task:plain', 'To do', { details: {} });
  assert.deepEqual((await listOpenWork(caller(shipped))).work, []);
  const declared = settingsFor(ENGINE_STEPS);
  const { work } = await listOpenWork(caller(declared));
  assert.deepEqual(work.map(task => task.handoff_id).sort(), ['calendar-task:step-a', 'calendar-task:step-b']);
});

test('the store\'s filter is the rule plan() applies: a model of it over varied tasks reads the same ids', async () => {
  const shapes = [...ENGINE_STEPS, { for: ['person'], 'told_as.source': false }, { sent_by: ['ai:sender'] }];
  const settings = settingsFor(shapes);
  const me = meOf(settings);
  const { db, add, caller } = await store();
  const cases = [
    { assignees: [me] }, { assignees: ['ai:other'] }, { assignees: ['ai:other', me] }, { assignees: [] }, { taken_by: me, assignees: ['ai:other'] },
    { taken_by: 'ai:other', assignees: [] }, { details: step() }, { details: step({ for: 'person' }) }, { details: { for: 'person' } },
    { details: { for: 'person', told_as: { source: 'workflow-step-answered' } } }, { details: { for: 'person', told_as: { source: '' } } },
    { details: { for: 'person', told_as: {} } }, { details: { for: 'person', told_as: null } }, { details: { continuation: { owner: me } } },
    { details: { continuation: { owner: 'ai:other' } } }, { details: { source: { kind: 'chat', ref: 'claude-code:x' } } }, { details: { source: { kind: 'chat', ref: '' } } },
    { details: { source: { kind: 'mail', ref: 'm' } } }, { assignees: ['ai:other'], details: { source: { kind: 'chat', ref: 'claude-code:x' } } },
    { details: step({ asks: { do: 'x', submit: false, checks: [] } }) }, { details: step({ asks: { do: 'x', submit: {}, checks: [] } }) },
    { details: step({ asks: { do: 'x', submit: { type: 'object' } } }) }, { details: step({ asks: { do: 'x', submit: { type: 'object' }, checks: null } }) },
    { sent_by: 'ai:sender' }, { sent_by: 'ai:sender', assignees: ['ai:other'] }, { sent_by: 'ai:stranger' },
  ];
  for (const [at, row] of cases.entries()) await add(`calendar-task:case-${String(at).padStart(2, '0')}`, 'To do', row);
  // Fields the store keeps in columns are read as columns: a column value is the value plan() reads at the same path.
  const valueOf = (row, at) => ({ id: `calendar-task:case-${String(at).padStart(2, '0')}`, status: 'To do', assignees: row.assignees ?? [], taken_by: row.taken_by ?? undefined, sent_by: row.sent_by ?? undefined, ...(row.details ?? {}) });
  const model = task => {
    const nobody = task.assignees.length === 0;
    const turn = task.source?.kind === settings.turns.source_kind && typeof task.source.ref === 'string' && task.source.ref !== '';
    return task.assignees.includes(me) || task.taken_by === me || task.continuation?.owner === me || (nobody && (turn || takesUnassigned(task, shapes)));
  };
  const expected = cases.map(valueOf).filter(model).map(task => task.id).sort();
  const { work } = await listOpenWork(caller(settings));
  assert.deepEqual(work.map(task => task.handoff_id).sort(), expected);
  assert.ok(expected.length > 8 && expected.length < cases.length, 'the cases include some read and some left');
  await db.close();
});

test('the alternatives name every way a worker acts on a task, and refuse a shape that is not a list of values, true or false', () => {
  const alternatives = tasksThisWorkerMayTake({ turns: { source_kind: 'chat' }, tasks: { take_unassigned_when: [{ for: ['anyone'] }, {}] } }, ['ai:a', 'ai:a', 'user:a']);
  assert.equal(alternatives.length, 2 * 3 + 1 + 2, 'each distinct id is named once per way, then the turns, then each shape');
  assert.deepEqual(alternatives[0], { assignees: { contains: ['ai:a'] } });
  assert.deepEqual(alternatives.at(-1), { assignees: { holds: false } }, 'the shape {} fits every task that names nobody');
  assert.deepEqual(tasksThisWorkerMayTake({ tasks: {} }, ['ai:a']).length, 3, 'with no turns and no shapes only its own tasks are read');
  assert.throws(() => tasksThisWorkerMayTake({ tasks: { take_unassigned_when: [{ for: 'anyone' }] } }, ['ai:a']), /for must be a list of values, true or false/);
  assert.throws(() => tasksThisWorkerMayTake({ tasks: { take_unassigned_when: { for: ['anyone'] } } }, ['ai:a']), /must be a list of task shapes/);
});
