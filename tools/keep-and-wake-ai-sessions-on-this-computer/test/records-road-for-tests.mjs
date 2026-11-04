// test/records-road-for-tests.mjs
//
// The page's road to the person's own records in a browser test, answered from records held in memory the way the
// engine answers it: GET /work/api/door/records:read {id, type?} answers {id, type, value}; GET
// /work/api/door/records:list {type, prefix?, fields?, limit?, after?, where?} answers {records, next}, ids greatest first: `limit`
// of them read after `after`, those equal to `where` shown (next: the last id read, null after the last; every list input
// asked is kept in `lists`); POST
// /work/api/records {records} keeps each value as given (null erases) and answers {changed, write_count}.
// `listRecords` turns a list and its rows, as a screen draws them, into the records they are kept as.

/** The records `list` ({ id, row_type, ... }) and its `rows` ({ id, values }) are kept as. */
export function listRecords(list, rows = []) {
  const { id, rows: _count, ...value } = list;
  return [
    { id: `list:${id}`, type: 'list', value },
    ...rows.map(row => ({ id: `record:${list.row_type}:${row.id}`, type: `record:${list.row_type}`, value: row.values ?? {} })),
  ];
}

/** Records held in memory and the one answer for each request of the records road (null: not a records request). */
export function recordsRoad(records = []) {
  const held = new Map(records.map(record => [record.id, record]));
  const writes = [];
  const lists = [];
  const projected = (record, fields) => (Array.isArray(fields)
    ? { id: record.id, type: record.type, ...(fields.length ? { value: Object.fromEntries(fields.filter(field => field in (record.value ?? {})).map(field => [field, record.value[field]])) } : {}) }
    : record);
  const answer = (method, url, body) => {
    if (url.pathname.startsWith('/work/api/door/records:') && method === 'GET') {
      const input = JSON.parse(url.searchParams.get('input') ?? '{}');
      const operation = url.pathname.slice('/work/api/door/records:'.length);
      if (operation === 'read') {
        const found = held.get(input.id);
        return { id: input.id, type: input.type ?? found?.type ?? null, value: found && (!input.type || found.type === input.type) ? found.value : null };
      }
      if (operation === 'list') {
        const rows = [...held.values()].filter(record => record.type === input.type && (!input.prefix || record.id.startsWith(input.prefix)) && (!input.after || record.id < input.after))
          .sort((a, b) => (a.id < b.id ? 1 : -1));
        const read = rows.slice(0, input.limit ?? rows.length);
        const equal = record => Object.entries(input.where ?? {}).every(([field, value]) => JSON.stringify(record.value?.[field]) === JSON.stringify(value));
        lists.push(input);
        return { records: read.filter(equal).map(record => projected(record, input.fields)), next: read.length < rows.length ? read.at(-1).id : null };
      }
    }
    if (url.pathname === '/work/api/records' && method === 'POST' && Array.isArray(body?.records)) {
      writes.push(body.records);
      for (const record of body.records) {
        if (record.value === null) held.delete(record.id); else held.set(record.id, { id: record.id, type: record.type, value: record.value });
      }
      return { changed: true, write_count: body.records.length };
    }
    return null;
  };
  /** A Playwright route handler answering the records road, else handing the request on. */
  const route = async route => {
    const request = route.request();
    const found = answer(request.method(), new URL(request.url()), request.method() === 'POST' ? request.postDataJSON() : null);
    if (found === null) return route.fallback();
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(found) });
  };
  return { held, writes, lists, answer, route };
}
