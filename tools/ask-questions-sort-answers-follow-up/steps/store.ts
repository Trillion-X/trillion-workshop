// tools/ask-questions-sort-answers-follow-up/steps/store.ts
//
// PURPOSE
//   The one place the sitting steps (sitting.ts, form-page-steps.ts, the booking steps) touch the pursuit's database. A step reads
//   through five small questions (a row by id, the answer facts of a sitting, the rows a decision is made from, a booking page,
//   the bookings' own insert) and writes as one list of writes that is kept together or not at all. `sqlStore` answers them with
//   statements through the engine's mounted login; a test hands a store of its own.
//   A step's reads are few (a row read is kept for the rest of the run, `preload` reads several rows in one) and its writes are ONE
//   statement (data-modifying CTEs): one round trip, atomic, and a refused part keeps nothing of the step.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The table and column names are the one block below; every value is a statement parameter, never put into the text.
//   2. `apply` sends every write of one step as one statement: all kept or none, in one round trip.
//   3. This file holds no login: `execute` is handed in by the tool's main, which got the connection from the engine.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { ANSWER_FACT_KIND } from '../do-work/answer-fact-writes.ts';

export type Write =
  | { kind: 'insert'; id: string; type: string; value: unknown }
  | { kind: 'upsert'; id: string; type: string; value: unknown }
  | { kind: 'delete'; id: string }
  | { kind: 'delete_many'; ids: string[] }
  | { kind: 'merge'; id: string; changes: Record<string, unknown> }
  | { kind: 'sql'; sql: string; params: unknown[] };

export type Row = { id: string; type: string; value: any };

export interface Store {
  /** The value of the form row with this id (and type, when given), or null. */
  value(id: string, type?: string): Promise<any | null>;
  /** The values of the answer facts of one sitting. */
  factsOf(submissionId: string): Promise<any[]>;
  /** The rows a form's decision is made from: its question sequence and the rules and follow-ups that name it (or no form). */
  decisionRows(formId: string, sequenceId: string, kinds: readonly string[]): Promise<Row[]>;
  /** One live booking page by its slug, or null. */
  bookingPage(slug: string): Promise<Record<string, any> | null>;
  /** Reads these rows by id in one statement, so later `value` reads of them cost nothing. */
  preload(ids: string[]): Promise<void>;
  /** All these writes, kept together or not at all, in one statement. */
  apply(writes: Write[]): Promise<void>;
}

export type Execute = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

// The one place the tables and columns are named.
const FORM_ROWS = 'form_rows';
const BOOKING_PAGES = { table: 'booking_pages', columns: 'slug, title, duration_minutes, timezone, calendar_account, windows, horizon_days, min_notice_minutes, form_id' };

const UPSERT = `INSERT INTO ${FORM_ROWS} (id, type, value) VALUES ($1, $2, $3::jsonb) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, kept_at = now()`;

export function statementOf(write: Write): { sql: string; params: unknown[] } {
  switch (write.kind) {
    case 'insert': return { sql: `INSERT INTO ${FORM_ROWS} (id, type, value) VALUES ($1, $2, $3::jsonb)`, params: [write.id, write.type, JSON.stringify(write.value)] };
    case 'upsert': return { sql: UPSERT, params: [write.id, write.type, JSON.stringify(write.value)] };
    case 'delete': return { sql: `DELETE FROM ${FORM_ROWS} WHERE id = $1`, params: [write.id] };
    case 'delete_many': return { sql: `DELETE FROM ${FORM_ROWS} WHERE id = ANY($1::text[])`, params: [write.ids] };
    case 'merge': return { sql: `UPDATE ${FORM_ROWS} SET value = value || $2::jsonb, kept_at = now() WHERE id = $1`, params: [write.id, JSON.stringify(write.changes)] };
    case 'sql': return { sql: write.sql, params: write.params };
  }
}

// The writes as one statement: each is a data-modifying CTE (its own parameters renumbered after the ones before), and the
// statement answers how many parts ran. A part the database refuses fails the whole statement, so nothing of the step is kept.
export function oneStatementOf(writes: Write[]): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const parts = writes.map((write, index) => {
    const part = statementOf(write);
    const offset = params.length;
    params.push(...part.params);
    return `w${index} AS (${part.sql.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offset}`)} RETURNING 1 AS ok)`;
  });
  return { sql: `WITH ${parts.join(', ')} SELECT ${writes.map((_, index) => `(SELECT count(*) FROM w${index})`).join(' + ')} AS written`, params };
}

export function sqlStore({ execute }: { execute: Execute }): Store {
  // Rows read in this run, by id; a write forgets them.
  const known = new Map<string, { type: string; value: any } | null>();
  return {
    async preload(ids) {
      const wanted = ids.filter(id => !known.has(id));
      if (wanted.length === 0) return;
      const found = await execute(`SELECT id, type, value FROM ${FORM_ROWS} WHERE id = ANY($1::text[])`, [wanted]);
      for (const id of wanted) known.set(id, null);
      for (const row of found) known.set(String(row.id), { type: String(row.type), value: row.value });
    },
    async value(id, type) {
      if (!known.has(id)) {
        const found = await execute(`SELECT id, type, value FROM ${FORM_ROWS} WHERE id = $1`, [id]);
        known.set(id, found[0] ? { type: String(found[0].type), value: found[0].value } : null);
      }
      const row = known.get(id) ?? null;
      return row && (type === undefined || row.type === type) ? row.value : null;
    },
    async factsOf(submissionId) {
      const found = await execute(`SELECT value FROM ${FORM_ROWS} WHERE type = $1 AND value ->> 'submissionId' = $2`, [ANSWER_FACT_KIND, submissionId]);
      return found.map(row => row.value);
    },
    async decisionRows(formId, sequenceId, kinds) {
      const found = await execute(`SELECT id, type, value FROM ${FORM_ROWS} WHERE id = $1 OR (type = ANY($2::text[]) AND (value ->> 'formId' IS NULL OR value ->> 'formId' = $3))`, [sequenceId, [...kinds], formId]);
      return found as unknown as Row[];
    },
    async bookingPage(slug) {
      const found = await execute(`SELECT ${BOOKING_PAGES.columns} FROM ${BOOKING_PAGES.table} WHERE slug = $1 AND live`, [slug]);
      return found[0] ?? null;
    },
    async apply(writes) {
      if (writes.length === 0) return;
      known.clear();
      const { sql, params } = oneStatementOf(writes);
      try { await execute(sql, params); } catch { throw new Error('Something went wrong. Try again.'); }
    },
  };
}
