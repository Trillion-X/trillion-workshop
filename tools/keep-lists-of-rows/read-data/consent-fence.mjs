// tools/keep-lists-of-rows/read-data/consent-fence.mjs
//
// PURPOSE
//   What a list read answers when the database fences the table (a consent check, use_binding.fenced): a fenced table
//   read for a use it does not allow is refused, so the screen says so, instead of drawing an empty list. The statement
//   that reads the rows also asks the fence, in the same statement, so the answer and the rows agree.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A table is refused only when the fence says it is fenced and not allowed for this use; every other answer draws the rows.
//   2. A database with no use_binding schema is not fenced: its answer is the rows as they are.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

/** The error a database without a use_binding schema answers (its tables are not fenced). */
export const NO_USE_BINDING = /schema "use_binding" does not exist/;

/** The answer of one statement that asks the fence and reads one page of rows: { refused, rows }. */
export function fencedReadOf(answer) {
  const rows = typeof answer?.rows === 'string' ? JSON.parse(answer.rows) : answer?.rows;
  return { refused: answer?.fenced === true && answer?.allowed !== true, rows: Array.isArray(rows) ? rows : [] };
}
