// parts/ui/show/file-preview/read-delimited-text.ts
//
// PURPOSE
//   Reads delimited text (comma, tab, semicolon, pipe or any separator a file-viewers.json row names) into rows of
//   cells, the way a spreadsheet opens it: a quoted cell may hold the separator, a line break or a doubled quote.
//   The table viewer draws the rows in the same grid a workbook sheet uses.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The separator is handed in; nothing here names a format.
//   2. Bounded: at most MAX_ROWS rows and MAX_COLUMNS cells a row are kept, and `cut` says when more were left out.
//   3. A text whose end was cut off mid-file (`partial`) drops its last, possibly half-read, line and says it was cut.

export const DELIMITED_LIMITS = { rows: 5000, columns: 200 } as const;

export interface DelimitedReading {
  readonly rows: readonly (readonly string[])[];
  /** More rows or cells exist than are kept here. */
  readonly cut: boolean;
}

/** Splits `text` into rows of cells by `separator`. `partial` says the text is the first part of a longer file. */
export function readDelimitedText(text: string, separator: string, partial = false, limits: { rows: number; columns: number } = DELIMITED_LIMITS): DelimitedReading {
  if (!separator) throw new Error('A separator is needed to read delimited text.');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let cut = false;
  let at = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endCell = () => {
    if (row.length < limits.columns) row.push(cell);
    else cut = true;
    cell = '';
  };
  const endRow = () => {
    endCell();
    if (rows.length < limits.rows) rows.push(row);
    else cut = true;
    row = [];
  };
  while (at < text.length) {
    const char = text[at];
    if (quoted) {
      if (char === '"') {
        if (text[at + 1] === '"') { cell += '"'; at += 2; continue; }
        quoted = false; at += 1; continue;
      }
      cell += char; at += 1; continue;
    }
    if (char === '"' && cell === '') { quoted = true; at += 1; continue; }
    if (text.startsWith(separator, at)) { endCell(); at += separator.length; continue; }
    if (char === '\r' || char === '\n') {
      endRow();
      at += char === '\r' && text[at + 1] === '\n' ? 2 : 1;
      if (rows.length >= limits.rows && at < text.length) { cut = true; break; }
      continue;
    }
    cell += char; at += 1;
  }
  // The last line: kept when the file ended there, dropped when the read stopped part way through it.
  if (at >= text.length && (cell !== '' || row.length > 0)) {
    if (partial) cut = true;
    else endRow();
  } else if (partial) cut = true;
  return { rows, cut };
}
