// src/workspace/records-door.ts
//
// PURPOSE
//   The page's one road to the person's own records: every read through the records door's generic read (GET
//   /work/api/door/records:read and records:list, the same read an AI's key reaches over MCP, admitted by the page's
//   own session), every change through the one records write (POST /work/api/records). Lists (list-records.ts) and
//   Home (home-screen.tsx) read and write records only through this file.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a kind of record: each caller names its type, order and prefix from its own DATA.
//   2. A list read follows the door's pages (`next`) to the end or until `most` are read, and says where a later read
//      goes on from; an erased record (value null) is never handed on.
//   3. A page the door could not answer whole (a record larger than one answer) fails in words; it never draws a part.

import { postJson, postNothingRead, readItemJson } from './api';

import { recordScope, sameRecordScope as sameScope, type RecordScope, type RecordContext } from './record-history';
export { recordScope, type RecordScope, type RecordContext } from './record-history';
export type StoredRecord = { id: string; type?: string; value: Record<string, unknown> | null; expected?: null | { type: string; value?: unknown; identity?: string }; scope?: RecordScope; context?: RecordContext };
type Page = { records?: StoredRecord[]; next?: string | null; scope?: RecordScope; context?: RecordContext };

function returnedContext<T extends { scope?: RecordScope; context?: RecordContext }>(answer: T, asked?: RecordScope): T {
  const scope = answer.scope === undefined ? undefined : recordScope(answer.scope);
  if (asked && (!scope || !sameScope(asked, scope))) throw new Error('The records door answered another history.');
  const context = answer.context;
  if (context !== undefined && (!context || !Number.isSafeInteger(context.generation) || context.generation < 1
    || (scope && context.generation !== scope.generation))) throw new Error('The records door answered an invalid current context.');
  return { ...answer, ...(scope ? { scope } : {}) };
}

const door = <T>(operation: 'list' | 'read', input: Record<string, unknown>) =>
  readItemJson<T>(`/work/api/door/records:${operation}?input=${encodeURIComponent(JSON.stringify(input))}`);
const tooLarge = () => new Error('A record is too large to show here. Ask your AI to read it.');

/** One record's value as kept now, or null when there is none of that type. */
export async function readRecordState(id: string, type: string, scope?: RecordScope): Promise<StoredRecord> {
  const asked = scope === undefined ? undefined : recordScope(scope);
  const answer = returnedContext(await door<StoredRecord>('read', { id, type, ...(asked ? { scope: asked } : {}) }), asked);
  if (answer.id !== id || (answer.value !== null && answer.type !== undefined && answer.type !== type)) {
    throw new Error('The records door answered another record.');
  }
  return answer;
}

/** Value-only callers keep their established contract; history-aware owners retain readRecordState instead. */
export async function readRecord(id: string, type: string, scope?: RecordScope): Promise<Record<string, unknown> | null> {
  return (await readRecordState(id, type, scope)).value ?? null;
}

/** The records one list read names (`type`, and its `order`, `prefix`, `reverse` or `fields`), from `after` (a
 *  previous read's `next`; the start when null), following the door's pages until `most` are read, `pages` pages were
 *  asked, or there are no more. `next` is where a later read goes on from, null when every record was read. */
export async function listRecordsFrom(input: Record<string, unknown>, most: number, after: string | null = null, pages = Infinity): Promise<{ records: StoredRecord[]; next: string | null }> {
  const found: StoredRecord[] = [];
  const scope = input.scope === undefined ? undefined : recordScope(input.scope);
  let asked = 0;
  do {
    asked += 1;
    // With `where`, a page's limit bounds the rows the door reads, not the rows it shows: the whole 999 are read each time,
    // so a rule few rows meet is answered in a few calls, and every row shown is kept (a page may hold more than `most`).
    const page = returnedContext(await door<Page>('list', { ...input, ...(scope ? { scope } : {}), limit: input.where ? 999 : Math.min(999, most - found.length), ...(after ? { after } : {}) }), scope);
    if (!Array.isArray(page.records)) throw tooLarge();
    for (const record of page.records) {
      if (record.value === null) continue;
      const row = returnedContext({ ...record, ...(record.scope === undefined && page.scope ? { scope: page.scope } : {}),
        ...(record.context === undefined && page.context ? { context: page.context } : {}) }, scope);
      found.push(row);
    }
    after = page.next ?? null;
  } while (after && found.length < most && asked < pages);
  return { records: found, next: after };
}

/** The records one list read names, following the door's pages to the end or until `most` are read. */
export async function listRecords(input: Record<string, unknown>, most = Infinity): Promise<StoredRecord[]> {
  return (await listRecordsFrom(input, most)).records;
}

type Written = { changed: boolean; write_count: number };
/** Writes each record whole (a value of null erases it), in one write. A `quiet` write leaves every read this page
 *  keeps standing (api.ts postNothingRead), for a write no screen draws, such as a timing kept in the background. */
export const writeRecords = (records: StoredRecord[], { quiet = false, scope, create = false }: { quiet?: boolean; scope?: RecordScope; create?: boolean } = {}) => {
  const selected = scope === undefined ? undefined : recordScope(scope);
  if (create && !selected) throw new Error('Creating a record history needs its complete identity.');
  for (const record of records) {
    if ((record.context !== undefined && record.scope === undefined && selected)
      || (record.scope !== undefined && (!selected || !sameScope(recordScope(record.scope), selected)))) {
      throw new Error('One records command cannot mix independent histories.');
    }
  }
  // Context is transport custody, never part of a user record or a second write.
  const writes = records.map(({ scope: _scope, context: _context, ...record }) => record);
  const input = { records: writes, ...(selected ? { scope: { ...selected, ...(create ? { create: true } : {}) } } : {}) };
  return quiet ? postNothingRead<Written>('/work/api/records', input) : postJson<Written>('/work/api/records', input);
};
