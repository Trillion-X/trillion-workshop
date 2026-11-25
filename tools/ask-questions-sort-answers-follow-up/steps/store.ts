// tools/ask-questions-sort-answers-follow-up/steps/store.ts
//
// PURPOSE
//   The one place the sitting steps (sitting.ts, form-page-steps.ts, the booking steps) touch the pursuit's database. A step reads
//   through five small questions (a row by id, the answer facts of a sitting, the rows a decision is made from, a booking page,
//   the bookings' own insert) and writes as one list of writes that is kept together or not at all. `sqlStore` answers them with
//   statements through the engine's mounted login; a test hands a store of its own.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The table and column names are the one block below; every value is a statement parameter, never put into the text.
//   2. `apply` sends every write of one step as one transaction: all kept or none.
//   3. This file holds no login: `execute` and `commit` are handed in by the tool's main, which got the connection from the engine.
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
  /** All these writes, kept together or not at all. */
  apply(writes: Write[]): Promise<void>;
}

export type Execute = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
export type Commit = (statements: { sql: string; params: unknown[] }[]) => Promise<void>;

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

export function sqlStore({ execute, commit }: { execute: Execute; commit: Commit }): Store {
  return {
    async value(id, type) {
      const found = type === undefined
        ? await execute(`SELECT value FROM ${FORM_ROWS} WHERE id = $1`, [id])
        : await execute(`SELECT value FROM ${FORM_ROWS} WHERE id = $1 AND type = $2`, [id, type]);
      return found[0]?.value ?? null;
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
      if (writes.length > 0) await commit(writes.map(statementOf));
    },
  };
}
