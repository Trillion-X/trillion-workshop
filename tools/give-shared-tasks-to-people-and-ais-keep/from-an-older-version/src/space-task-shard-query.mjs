// Bounded global queue selection for task rows that remain owned by their
// addressed handoff shard. Cursors carry the real queue tuple so fanout does
// not restart or skip work when pages from independent shards are merged.
export const TASK_QUEUE_PAGE_MAX = 100;

export function taskQueueCursorOf(handoff) {
  return {
    priority: Number(handoff?.priority ?? 0),
    handed_at: String(handoff?.handed_at ?? ''),
    handoff_id: String(handoff?.handoff_id ?? ''),
  };
}

export function taskQueueCursorAfter(cursor, row) {
  if (!cursor) return true;
  const left = taskQueueCursorOf(row);
  const right = taskQueueCursorOf(cursor);
  return left.priority < right.priority
    || (left.priority === right.priority && (left.handed_at > right.handed_at
      || (left.handed_at === right.handed_at && left.handoff_id > right.handoff_id)));
}

export function mergeTaskShardQueuePages(pages, limit = TASK_QUEUE_PAGE_MAX) {
  if (!Number.isInteger(limit) || limit < 1 || limit > TASK_QUEUE_PAGE_MAX) {
    throw new Error(`Task queue page limit must be between 1 and ${TASK_QUEUE_PAGE_MAX}.`);
  }
  const rows = pages.flatMap(page => page?.items ?? []);
  rows.sort((a, b) => {
    const left = taskQueueCursorOf(a);
    const right = taskQueueCursorOf(b);
    return right.priority - left.priority
      || left.handed_at.localeCompare(right.handed_at)
      || left.handoff_id.localeCompare(right.handoff_id);
  });
  const items = rows.slice(0, limit);
  const more = rows.length > limit || pages.some(page => Boolean(page?.more));
  return {
    items,
    next_cursor: more && items.length ? taskQueueCursorOf(items.at(-1)) : null,
    more,
  };
}

// This query reads only the bounded candidate page from one task owner. The
// caller validates the winner by invoking the immutable handoff route; the
// query is an index, never authority to claim or move a task.
export function spaceTaskQueuePage(sql, { space_id, to_agent = null, now_iso, after = null, limit = 4 }) {
  if (typeof space_id !== 'string' || !space_id || typeof now_iso !== 'string') {
    throw new Error('A Space and queue observation time are required.');
  }
  if (to_agent !== null && typeof to_agent !== 'string') throw new Error('Task addressee must be a string or null.');
  if (!Number.isInteger(limit) || limit < 1 || limit > TASK_QUEUE_PAGE_MAX) {
    throw new Error(`Task queue page limit must be between 1 and ${TASK_QUEUE_PAGE_MAX}.`);
  }
  if (after && (!Number.isFinite(Number(after.priority)) || typeof after.handed_at !== 'string' || typeof after.handoff_id !== 'string')) {
    throw new Error('Task queue cursor is invalid.');
  }
  const cursorSql = after
    ? 'AND (priority < ?4 OR (priority = ?4 AND (handed_at, handoff_id) > (?5, ?6)))'
    : '';
  const binds = after
    ? [space_id, to_agent, now_iso, Number(after.priority), after.handed_at, after.handoff_id, limit + 1]
    : [space_id, to_agent, now_iso, limit + 1];
  const rows = sql.exec(`SELECT value FROM space_handoffs
    WHERE space_id = ?1 AND open = 1
      AND (CASE WHEN ?2 IS NULL THEN to_agent IS NULL OR prefer_until <= ?3 ELSE to_agent = ?2 END)
      ${cursorSql}
    ORDER BY priority DESC, handed_at, handoff_id LIMIT ?${after ? 7 : 4}`, ...binds).toArray();
  const found = rows.map(row => JSON.parse(row.value));
  const items = found.slice(0, limit);
  return { items, next_cursor: found.length > limit ? taskQueueCursorOf(items.at(-1)) : null, more: found.length > limit };
}
