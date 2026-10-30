// The motion bar: what a piece must reach to move about as much as the video it copies. The rows of the bar are not here:
// the person passes them in (a record of kind motion-bar). Each row names one measure of the reference, which way the piece
// must stand against it and how far: a number of times the reference's own value, or a fixed value. Pure: it reads a
// measurement and rows and returns numbers.

export const KIND = 'motion-bar';
const RELATIONS = { at_least: (piece, bar) => piece >= bar, at_most: (piece, bar) => piece <= bar };

/** The rows of a motion-bar record, or an Error saying what to change. */
export function rowsOf(record) {
  if (record?.kind !== KIND) return new Error(`The bar must be an object with "kind": "${KIND}".`);
  if (!Array.isArray(record.rows) || record.rows.length === 0) return new Error('The bar needs "rows": a list with at least one row.');
  const names = new Set();
  for (const [index, row] of record.rows.entries()) {
    const where = `bar row ${index}`;
    if (typeof row?.measure !== 'string' || !row.measure) return new Error(`${where} needs "measure": the name of a number the measuring module gives (for example moving_share).`);
    if (!(row.relation in RELATIONS)) return new Error(`${where} needs "relation": "at_least" or "at_most".`);
    const given = ['times_reference', 'value'].filter(key => row[key] !== undefined);
    if (given.length !== 1 || typeof row[given[0]] !== 'number' || !Number.isFinite(row[given[0]])) {
      return new Error(`${where} needs exactly one number, "times_reference" (a multiple of the reference's own value) or "value" (a fixed number).`);
    }
    for (const key of ['name', 'bar_key']) {
      if (typeof row[key] !== 'string' || !row[key]) return new Error(`${where} needs "${key}": the key its answer is kept under.`);
    }
    if (names.has(row.name)) return new Error(`${where}: the name ${row.name} is used twice.`);
    names.add(row.name);
  }
  return record.rows;
}

/** The bar for a reference measured as { [measure]: number }: { [bar_key]: number } per row. */
export function barFor(reference, rows) {
  return Object.fromEntries(rows.map(row => [row.bar_key, row.value ?? row.times_reference * reference[row.measure]]));
}

/** Whether a piece clears each row, one answer per row (by name) and overall. */
export function judge(draft, bar, rows) {
  const pass = Object.fromEntries(rows.map(row => [row.name, RELATIONS[row.relation](draft[row.measure], bar[row.bar_key])]));
  return { pass, verdict: Object.values(pass).every(Boolean) ? 'passed' : 'failed' };
}
