// tools/ask-questions-sort-answers-follow-up/read-data/kept-rows.mjs
//
// How the form tools see the person's rows: as values. The caller reads the rows a call needs from wherever the person keeps
// them and hands them in as `rows` ([{ id, type, value }], type the row's kind); a tool that makes rows answers them as `keep`,
// and the caller writes those to the person's own database. Nothing here reaches a database.
//
//   readRows(rows, kind, { id?, formId?, respondentId? })   the given rows of one kind, by id order, matching the value's formId and respondentId
//   givenRows(input)                                          input.rows, checked to be rows
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function givenRows(input) {
  const rows = input?.rows ?? [];
  if (!Array.isArray(rows) || !rows.every(row => object(row) && typeof row.id === 'string' && typeof row.type === 'string' && object(row.value))) {
    throw new Error('rows must be the person\'s form rows this call reads, each { id, type, value }.');
  }
  return rows;
}

export function readRows(rows, kind, { id, formId, respondentId } = {}) {
  return rows
    .filter(row => row.type === kind && (id === undefined || row.id === id)
      && (formId === undefined || row.value.formId === formId) && (respondentId === undefined || row.value.respondentId === respondentId))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(row => ({ id: row.id, type: kind, value: row.value }));
}
