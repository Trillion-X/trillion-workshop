// tools/calendar/web/src/workspace/calendar-task-rows.mjs
//
// PURPOSE
//   The Calendar's task rows in the task owner's own table (public.calendar_tasks in the person's database), as the SQL
//   the screen runs through tool:run-sql-in-my-database and the Task shape it draws. Pure: no network, no page. The
//   owner's database, table, timeout and limits are calendar-owners.json's `tasks` block; the signed-in person's id is
//   read at run time by calendar-owners.ts and handed in here.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A person's tasks are the rows whose assignees name him or that he sent. A row sent by an AI or a workflow stays
//      out unless it names him in assignees.
//   2. Every query has a statement timeout and a row limit, and reads from the newest rows first.
//   3. Without a signed-in person id nothing is read and nothing is written: the caller answers the empty state.
//   4. Column names come from the `columns` block of calendar-owners.json, not from this file's text.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

/** The person's id from a bearer token whose payload carries a `sub` (a JWT). An opaque token has none: null. */
export function personOfToken(token) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(parts[1].length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const subject = JSON.parse(new TextDecoder().decode(bytes)).sub;
    return typeof subject === 'string' && subject ? subject : null;
  } catch {
    return null;
  }
}

/** The SELECT for one person's open tasks, newest first, limited. `assignees` is a JSON array of record ids. */
export function personTasksQuery(owner, person) {
  const c = owner.columns;
  const sql = `select ${[c.id, c.title, c.description, c.priority, c.labels, c.duration_minutes, c.minimum_duration_minutes,
    c.due, c.starts_at, c.ends_at, c.status, c.collection_id, c.parent_id, c.manual_order, c.source_id, c.made_at, c.assignees, c.sent_by].join(', ')}
    from public.${owner.table}
    where (${c.assignees} @> $1::jsonb or ${c.sent_by} = $2) and (${c.status} is null or ${c.status} <> all($3::text[]))
      and not (coalesce(${c.details}->'source'->>'kind', '') = any($5::text[]))
    order by ${c.made_at} desc nulls last
    limit $4`;
  return { sql, params: [JSON.stringify([person]), person, owner.hidden_statuses, owner.most_tasks, owner.excluded_source_kinds] };
}

/** The INSERT of a task the person typed: sent by him and assigned to him, so the list shows it at once. */
export function createTaskQuery(owner, person, input, id, nowIso) {
  const c = owner.columns;
  const sql = `insert into public.${owner.table} (${c.id}, ${c.title}, ${c.status}, ${c.duration_minutes}, ${c.collection_id}, ${c.smart_list},
    ${c.assignees}, ${c.sent_by}, ${c.made_at}, ${c.changed_at})
    values ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, $9)
    returning ${[c.id, c.title, c.description, c.priority, c.labels, c.duration_minutes, c.minimum_duration_minutes,
      c.due, c.starts_at, c.ends_at, c.status, c.collection_id, c.parent_id, c.manual_order, c.source_id, c.made_at, c.assignees, c.sent_by].join(', ')}`;
  return {
    sql,
    params: [id, input.title, owner.new_status, input.duration_minutes ?? null, input.collection_id ? JSON.stringify(input.collection_id) : null,
      input.smart_list ?? null, JSON.stringify([person]), person, nowIso],
  };
}

/** One database row as the Task the screen draws. Missing words stay empty; a missing duration is the screen's default. */
export function taskOfRow(row, owner) {
  const text = value => (typeof value === 'string' ? value : null);
  return {
    id: row.id,
    title: row.title ?? '',
    description: row.description ?? '',
    priority: text(row.priority),
    labels: Array.isArray(row.labels) ? row.labels.filter(label => typeof label === 'string') : [],
    duration_minutes: Number(row.duration_minutes ?? owner.default_minutes),
    minimum_duration_minutes: row.minimum_duration_minutes == null ? null : Number(row.minimum_duration_minutes),
    due: text(row.due),
    starts_at: text(row.starts_at),
    ends_at: text(row.ends_at),
    status: row.status ?? owner.default_status,
    collection_id: text(row.collection_id),
    parent_id: text(row.parent_id),
    manual_order: text(row.manual_order),
    source_id: text(row.source_id),
    created_at: text(row.made_at),
    assignees: Array.isArray(row.assignees) ? row.assignees : [],
    sent_by: text(row.sent_by),
  };
}
