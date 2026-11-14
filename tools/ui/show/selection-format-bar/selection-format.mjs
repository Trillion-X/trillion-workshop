// parts/ui/show/selection-format-bar/selection-format.mjs
//
// PURPOSE
//   What a formatting command does to the selected words of a plain-text field: wrap them in marks (bold, italic, a link) or
//   put a mark at the start of each selected line (a list). Pure: it answers the new text and where the selection sits
//   afterward, and the same command on the result undoes it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A command is a row of DATA: `wrap: [before, after]` or `prefix`, and optionally `select_after`, a stretch of `after`
//      the selection lands on (the address of a link, ready to be typed over). Nothing here names a command.
//   2. Text outside the selection is never changed except by the marks.

/**
 * @param {string} value the field's text
 * @param {number} start where the selection starts
 * @param {number} end where it ends (after start)
 * @param {{ wrap?: [string, string], prefix?: string, select_after?: string }} command
 * @returns {{ value: string, start: number, end: number }}
 */
export function applyFormat(value, start, end, command) {
  if (!(Number.isInteger(start) && Number.isInteger(end)) || start < 0 || end > value.length || start >= end) return { value, start, end };
  if (command.prefix) {
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const lineEndAt = value.indexOf('\n', end);
    const stop = lineEndAt < 0 ? value.length : lineEndAt;
    const lines = value.slice(lineStart, stop).split('\n');
    const all = lines.every(line => line.startsWith(command.prefix));
    const changed = lines.map(line => (all ? line.slice(command.prefix.length) : line.startsWith(command.prefix) ? line : command.prefix + line)).join('\n');
    return { value: value.slice(0, lineStart) + changed + value.slice(stop), start: lineStart, end: lineStart + changed.length };
  }
  const [before, after] = command.wrap ?? ['', ''];
  const wrapped = !command.select_after && value.slice(start - before.length, start) === before && value.slice(end, end + after.length) === after && start >= before.length;
  if (wrapped) {
    return { value: value.slice(0, start - before.length) + value.slice(start, end) + value.slice(end + after.length), start: start - before.length, end: end - before.length };
  }
  const next = value.slice(0, start) + before + value.slice(start, end) + after + value.slice(end);
  if (command.select_after) {
    const at = after.indexOf(command.select_after);
    if (at >= 0) { const from = end + before.length + at; return { value: next, start: from, end: from + command.select_after.length }; }
  }
  return { value: next, start: start + before.length, end: end + before.length };
}
