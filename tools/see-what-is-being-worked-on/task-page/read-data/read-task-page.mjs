// tools/see-what-is-being-worked-on/task-page/read-data/read-task-page.mjs
//
// A task page reads its task rows from the pursuit's own database on each request: the tasks, every change made to them,
// the status words with what each one means, and the things each task produced (its shows). One read is one SELECT that
// answers one JSON object, so nothing is copied, kept or timed anywhere. The caller hands in the SQL runner (one statement
// text in, { rows } out) and names the database; this file names no store and no product. Table names are plain
// identifiers: the defaults are the shape of a pursuit's task tables, and a pursuit whose tables are named otherwise passes
// its own names.
//
// The column names are the shape a pursuit's task tables keep: tasks (id, title, plain_title, plain_detail, parent_id,
// status, waiting_on, made_at, changed_at, and evidence when the table has it: what shows the status is true, read as
// text and absent when the table has no such column); changes (task_id, at, kind, status, title, id); statuses (name, mark, tone,
// counts_as_done, closed, place); shows (task_id, ref, label, made_at). A show is a thing a task produced that the page
// draws inline: `ref` is any address the shower can open (an https address, or a file the host can reach), `label` says
// what it is.

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

export const DEFAULT_TASK_TABLES = Object.freeze({ tasks: 'calendar_tasks', changes: 'task_changes', statuses: 'task_statuses', shows: 'task_shows' });

/** The one SELECT that reads the four tables as one JSON object. Read-only: no write verb, one statement. */
export function taskPageSql(tables = DEFAULT_TASK_TABLES) {
  const { tasks, changes, statuses, shows } = { ...DEFAULT_TASK_TABLES, ...tables };
  for (const name of [tasks, changes, statuses, shows]) {
    if (typeof name !== 'string' || !IDENTIFIER.test(name)) throw new Error(`A task table name must be a plain identifier, got ${JSON.stringify(name)}.`);
  }
  return 'select json_build_object('
    + `'tasks', (select json_agg(json_build_object('id', id, 'title', title, 'plain_title', plain_title, 'plain_detail', plain_detail, 'parent', coalesce(parent_id->>0, parent_id#>>'{}'), 'status', status, 'waiting_on', waiting_on, 'evidence', to_jsonb(${tasks})->>'evidence') order by coalesce(made_at, changed_at), id) from ${tasks}), `
    + `'statuses', (select json_agg(json_build_object('name', name, 'mark', mark, 'tone', tone, 'counts_as_done', counts_as_done, 'closed', closed, 'place', place) order by place) from ${statuses}), `
    + `'shows', (select json_agg(json_build_object('task', task_id, 'ref', ref, 'label', label, 'made_at', made_at) order by made_at, task_id, ref) from ${shows}), `
    + `'changes', (select json_agg(json_build_object('task', task_id, 'at', at, 'kind', kind, 'status', status, 'title', case when kind = 'from transcript' then title end) order by at, id) from ${changes})`
    + ') as data';
}

/** The page's data from the runner's rows: the first row's `data` object, each list mapped to its fields, a missing list
 *  is empty. A row with no data object is an error, never an empty page. */
export function taskPageFrom(rows) {
  const data = Array.isArray(rows) ? rows[0]?.data : undefined;
  if (!data || typeof data !== 'object') throw new Error('The task page read answered no data object.');
  const list = value => (Array.isArray(value) ? value : []);
  const text = value => (typeof value === 'string' && value !== '' ? value : null);
  return {
    tasks: list(data.tasks).map(task => ({
      id: String(task.id),
      title: String(task.title ?? ''),
      plain_title: text(task.plain_title),
      plain_detail: text(task.plain_detail),
      parent: text(task.parent),
      status: text(task.status) ?? '',
      waiting_on: text(task.waiting_on),
      evidence: text(task.evidence),
    })),
    statuses: list(data.statuses).map(status => ({
      name: String(status.name),
      mark: String(status.mark),
      tone: text(status.tone),
      counts_as_done: status.counts_as_done === true,
      closed: status.closed === true,
      place: Number(status.place),
    })),
    shows: list(data.shows).map(show => ({
      task: String(show.task),
      ref: String(show.ref),
      label: String(show.label),
      made_at: String(show.made_at),
    })),
    changes: list(data.changes).map(change => ({
      task: String(change.task),
      at: String(change.at),
      kind: String(change.kind),
      status: text(change.status),
      title: text(change.title),
    })),
  };
}

/** The task page's data, read through the caller's SQL runner: `runSql(sql)` answers `{ rows }`. */
export async function readTaskPage(runSql, tables) {
  if (typeof runSql !== 'function') throw new TypeError('readTaskPage needs a SQL runner: (sql) => { rows }.');
  const { rows } = await runSql(taskPageSql(tables));
  return taskPageFrom(rows);
}
