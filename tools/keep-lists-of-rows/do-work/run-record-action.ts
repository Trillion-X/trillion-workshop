// parts/visual-database/do-work/run-record-action.ts
//
// PURPOSE
//   Run one DATA action (visual-database's own action descriptor: a target, an operation or definition ids, input,
//   copies, generated values) on one record of any list, through the ported interpreter (visual-database-actions.ts),
//   so a column's button or a record's menu row runs whatever its row names: a Workshop tool, an AI hand-off, any
//   target the page answers.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The action's meaning is its DATA; nothing here names a target or an action.
//   2. A row with no target is refused with the interpreter's own words, never run against a default.
//   3. The record goes to the interpreter as a visual-database record (its id as its address), so `copy` reads
//      `record.*`, and a column action's `value` is the value of the column it sits in.
//   4. A record's own values go as the interpreter's `answers` only when the caller passes them (a person's list, whose
//      button reads the row), so `copy` maps them with `answers.<field id>`; the tool still takes only what it declares.

import { decodeVisualDatabaseActions, type VisualDatabaseActionDescriptor, type VisualDatabaseRecord } from '../read-data/visual-database';
import { invokeVisualDatabaseAction } from './visual-database-actions';

/** Every action row of a list, decoded once. */
export function recordActionsFromRows(rows: unknown): readonly VisualDatabaseActionDescriptor[] {
  return decodeVisualDatabaseActions({ actions: Array.isArray(rows) ? rows : [] });
}

/** Run one action on one record; `value` is the value of the column the action sits in, when it sits in one, and
 *  `answers` the record's own values by field id, which the action's `copy` reads as `answers.<field id>`. */
export function runRecordAction(
  action: VisualDatabaseActionDescriptor,
  record: { id: string; title: string; payload: unknown },
  value?: string,
  answers?: Readonly<Record<string, string>>,
): Promise<unknown[]> {
  const subject: VisualDatabaseRecord = {
    id: record.id,
    title: record.title,
    body: '',
    kind: 'record',
    group: 'record',
    lane: { id: 'unassigned', label: '', order: 0 },
    date: null,
    sort: null,
    badges: [],
    links: [],
    raw: { id: record.id, address: record.id, payload: record.payload },
  };
  return invokeVisualDatabaseAction(action, { record: subject, ...(value !== undefined ? { value } : {}), ...(answers ? { answers } : {}) });
}
