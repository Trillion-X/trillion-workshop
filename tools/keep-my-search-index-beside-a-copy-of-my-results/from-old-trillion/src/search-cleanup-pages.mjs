// Durable retirement walks seek by the table's indexed domain key, never by a rowid prefix combined with a lane filter.
// `columns` must follow an index whose leading columns are equality-constrained by `where`.
export function searchCleanupPageQuery({ table = null, name = null, where, columns, cursor = null }) {
  const key = Array.isArray(columns) ? columns : [];
  const target = table ?? name;
  if (typeof target !== 'string') throw new TypeError('A cleanup table name is required.');
  const hasCursor = key.length > 0 && Array.isArray(cursor) && cursor.length === key.length;
  const selected = ['rowid AS cleanup_rowid', ...key].join(', ');
  const order = key.length ? key.join(', ') : 'rowid';
  const seek = !hasCursor ? '' : key.length === 1 ? ` AND ${key[0]} > ?`
    : ` AND (${key.join(', ')}) > (${key.map(() => '?').join(', ')})`;
  return `SELECT ${selected} FROM ${target} WHERE ${where}${seek} ORDER BY ${order} LIMIT ?`;
}

export function searchCleanupPage(sql, spec, cursor, limit, ...values) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new RangeError('Search cleanup requires a page from 1 to 128 rows.');
  const key = Array.isArray(spec.columns) ? spec.columns : [];
  const after = Array.isArray(cursor) && cursor.length === key.length ? cursor : [];
  const query = searchCleanupPageQuery({ ...spec, cursor: after });
  // reads-ok: searchCleanupPageQuery always appends a terminal LIMIT; the validated page is at most 128 indexed keys.
  const rows = sql.exec(query, ...values, ...(after.length ? after : []), limit).toArray();
  return {
    rows,
    rowids: rows.map(row => row.cleanup_rowid),
    cursor: rows.length ? key.map(column => rows.at(-1)[column]) : after,
    more: rows.length === limit,
  };
}
