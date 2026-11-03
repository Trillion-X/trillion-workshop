// tools/move-code-between-trees/read-data/swap-calls.mjs
//
// Swap one provider's calls for the door's, by rows: { id, find, flags?, replace, means }. `find` is a regular expression
// over the file's text and `replace` its replacement ($1, $<name> as in String.replace). A detector row
// { id, find, flags? } names a provider call that must not be left in a moved file. Rows are data: a new provider call
// is a new row, never a change here.

const expression = (row, extra = '') => {
  try { return new RegExp(row.find, [...new Set(`${row.flags ?? ''}g${extra}`)].join('')); }
  catch (error) { throw new TypeError(`Call row ${row.id}: find is not a regular expression (${error.message}).`); }
};
const lineAt = (text, index) => text.slice(0, index).split('\n').length;

/** The text with every swap row applied in order, and where each row matched in the text it was given. */
export function swapCalls(text, rows = []) {
  const hits = [];
  let out = text;
  for (const row of rows) {
    if (typeof row.replace !== 'string') throw new TypeError(`Call row ${row.id}: replace must be text.`);
    const found = [...out.matchAll(expression(row))];
    if (!found.length) continue;
    hits.push({ id: row.id, count: found.length, lines: found.map(match => lineAt(out, match.index)) });
    out = out.replace(expression(row), row.replace);
  }
  return { text: out, hits };
}

/** Each detector match still in the text: { id, line, found }. */
export function providerCallsLeft(text, detectors = []) {
  return detectors.flatMap(row => [...text.matchAll(expression(row))].map(match => ({ id: row.id, line: lineAt(text, match.index), found: match[0].slice(0, 80) })));
}
