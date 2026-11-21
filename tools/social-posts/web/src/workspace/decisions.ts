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

/** A decision the person presses: the status it sets, its button words and the key that presses it. */
export type Verb = { status: string; label: string; key: string };

export type ShownField = { field: string; label: string; as?: 'list' | 'text'; empty?: string };

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
  /** Shows one waiting row at a time (Approve or Skip for it, then the next), with the rows left counted. */
  one_at_a_time: boolean;
  /** The field that must hold something for Approve to be offered (an email draft needs an address). Without it, Approve is always offered. */
  yes_needs?: string;
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

/** Where the next page of waiting rows starts: the order and id values of the last row the page before it showed. */
export type Cursor = { order: string; id: string };

/** One page of the rows that wait on the person's yes, in the source's order, after the cursor (none for the first page).
 *  The page is keyset-paged on (order, id), so a page starts from an index on the order and id, never from an offset. The
 *  order column must hold a value on every row a page can reach (a row with none would never be paged past). */
export function waitingPageStatement(source: DecisionSource, size: number, after: Cursor | null): Statement {
  if (!Number.isInteger(size) || size < 1) throw new Error('A page of waiting rows needs a whole number of rows above zero.');
  const columns = readFields(source).map(identifier).join(', ');
  const order = identifier(source.order);
  const id = identifier(source.id);
  const head = `select ${columns} from ${identifier(source.table)} where ${identifier(source.status)} = $1`;
  if (!after) return { sql: `${head} order by ${order}, ${id} limit $2`, params: [source.waiting, String(size)] };
  return {
    sql: `${head} and (${order}, ${id}) > ($2, $3) order by ${order}, ${id} limit $4`,
    params: [source.waiting, after.order, after.id, String(size)],
  };
}

/** How many rows wait on the person's yes: the same status as the page, counted and nothing else. */
export function waitingCountStatement(source: DecisionSource): Statement {
  return { sql: `select count(*) as waiting from ${identifier(source.table)} where ${identifier(source.status)} = $1`, params: [source.waiting] };
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

/** Whether a field's text holds nothing: none, an empty string, or an empty JSON list. */
export function isBlank(text: string | null, as: ShownField['as']): boolean {
  return shownWords(text, as).trim() === '';
}

/** Approve is offered only when the source's `yes_needs` field holds something: an email draft with no address is not sent. */
export function approvable(source: DecisionSource, row: Record<string, string | null>): boolean {
  if (!source.yes_needs) return true;
  const shown = source.shows.find(one => one.field === source.yes_needs);
  return !isBlank(row[source.yes_needs] ?? null, shown?.as);
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
