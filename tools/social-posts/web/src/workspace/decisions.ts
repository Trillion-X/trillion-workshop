// tools/social-posts/web/src/workspace/decisions.ts
//
// PURPOSE
//   The pure half of "Waiting on your yes" (pieces-screen.tsx): the SQL one decision source's DATA makes, and the values
//   it runs with. Any row that waits on a person's yes (an email draft, a post) is one source here, so one screen and one
//   owner answer Approve or Skip for every kind of row instead of a screen per kind.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every table, column and status word comes from the source's DATA (pieces.json `decisions.sources`). A name that
//      is not a plain lower-case identifier is refused before any SQL is made, so DATA can never inject text into SQL.
//   2. Values travel as parameters ($1, $2, $3), never inside the SQL text.
//   3. A decision changes a row only while the row still waits: the UPDATE names the waiting status in its WHERE, so a row
//      decided elsewhere matches nothing and changes nothing.
//   4. Nothing here draws or runs anything; pieces-screen.tsx runs the statements through tool:run-sql-in-my-database.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

export type Verb = { status: string; label: string };

export type ShownField = { field: string; label: string; as?: 'list' | 'text' };

export type DecisionSource = {
  label: string;
  database_suffix: string;
  table: string;
  id: string;
  title: string;
  status: string;
  decided_at: string;
  order: string;
  waiting: string;
  yes: Verb;
  skip: Verb;
  shows: ShownField[];
};

export type Statement = { sql: string; params: string[] };

const PLAIN_NAME = /^[a-z_][a-z0-9_]*$/;

/** A name from DATA as a quoted SQL identifier; any other text is refused. */
export function identifier(name: string): string {
  if (!PLAIN_NAME.test(name)) throw new Error(`"${name}" is not a plain name for a table or column.`);
  return `"${name}"`;
}

/** The columns a row of the source is read with: its id, its title, its order and every shown field, each once. */
export function readFields(source: DecisionSource): string[] {
  return [...new Set([source.id, source.title, source.order, ...source.shows.map(shown => shown.field)])];
}

/** The rows that wait on the person's yes, in the source's order, read with the waiting status as the one value. */
export function waitingRowsStatement(source: DecisionSource): Statement {
  const columns = readFields(source).map(identifier).join(', ');
  return {
    sql: `select ${columns} from ${identifier(source.table)} where ${identifier(source.status)} = $1 order by ${identifier(source.order)}, ${identifier(source.id)}`,
    params: [source.waiting],
  };
}

/** Sets the row's status to the verb's status and stamps the decision time, only while the row still waits. It answers
 *  the row's id when it changed a row and no rows when the row was decided elsewhere. */
export function decideStatement(source: DecisionSource, verb: Verb, rowId: string): Statement {
  const table = identifier(source.table);
  const status = identifier(source.status);
  const id = identifier(source.id);
  return {
    sql: `update ${table} set ${status} = $1, ${identifier(source.decided_at)} = now() where ${id} = $2 and ${status} = $3 returning ${id}`,
    params: [verb.status, rowId, source.waiting],
  };
}

/** A shown field's words: a list is read from its JSON array, anything else is the text as it is. */
export function shownWords(text: string | null, as: ShownField['as']): string {
  if (as !== 'list') return text ?? '';
  try {
    const value: unknown = text ? JSON.parse(text) : [];
    return Array.isArray(value) ? value.map(String).join(', ') : text ?? '';
  } catch {
    return text ?? '';
  }
}
