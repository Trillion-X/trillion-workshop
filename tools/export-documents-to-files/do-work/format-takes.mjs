// tools/export-documents-to-files/do-work/format-takes.mjs
//
// Whether a format can write a document, from the kinds of block it holds. Pure, so a screen can offer only the
// formats that will work before it asks the tool.
//
//   formatTakes(formatRow, kinds) -> boolean
//
// A kind the format draws is written; a graph or events block a format does not draw is written as tables, so it
// needs `table`; ink marks are a picture; a picture the format does not draw is refused.

export function formatTakes(format, kinds) {
  return kinds.every(kind => {
    const own = kind === 'ink' ? 'picture' : kind;
    if (format.draws.includes(own)) return true;
    return (kind === 'graph' || kind === 'events') && format.draws.includes('table');
  });
}
