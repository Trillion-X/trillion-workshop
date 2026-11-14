// src/workspace/record-source.ts
//
// PURPOSE
//   Where a `record` form field (parts/ui/show/record-picker) searches the person's lists and makes a row that is not
//   found yet: the person's lists as their own records (list-records.ts: the records door's read and the one records
//   write). Handed to the shared form body as `records`, as `yourFiles` is for a file box.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a list or a kind of row: the field's own descriptor (`from`, `new`) says which.
//   2. One owner: a list is made only by list-records.ts `ensureList` (never rewritten once it exists), a row only by its
//      `putRows`; a refusal is passed on in its own words.
//   3. A new row is a row of the list the field names, its title in that list's title field, so a search finds it next.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import type { RecordFrom, RecordHit, RecordNew, RecordSource } from '../../parts/ui/show/record-picker';
import { ensureList, putRows, searchRows } from './list-records';

const wordsOf = (id: string) => id.replace(/-/g, ' ').replace(/^./, letter => letter.toUpperCase());

export const recordSource: RecordSource = {
  search: (query: string, from: RecordFrom, limit?: number): Promise<RecordHit[]> => searchRows(query, from, limit),
  async create(made: RecordNew, title: string) {
    const field = made.title_field ?? 'name';
    // The list is made once when it is missing and never rewritten when it is there.
    const list = await ensureList(made.list, { label: made.list_label ?? wordsOf(made.list), title_field: field, fields: [{ id: field, label: 'Name', kind: 'text' }] });
    const [id] = await putRows(list, [{ values: { [list.title_field ?? field]: title } }]);
    return { id, list_id: made.list, list_label: list.label, title };
  },
};
