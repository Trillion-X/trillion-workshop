// tools/read-a-list-view/read-data/sources.mjs
//
// Purpose: the folder side of a row source, run on this computer by the Workshop functions that read and change the
// folder (tools/documents-as-list-rows). A source kind's read and change functions are named here once; the kinds
// themselves and their templates are DATA (read-data/list-view.json `row_sources`).
//
// Non-Negotiable Invariants:
//   1. A kind with no change function cannot be a list's original copy (list-view.mjs refuses such a declaration).
//   2. A kind is added by one entry here and one in list-view.json, never by a branch in the sync or the refresh.
import { changeDocumentRows, readDocumentRows } from '../../documents-as-list-rows/read-data/rows.mjs';
import { changeJsonItemRows, readJsonItemRows } from '../../documents-as-list-rows/read-data/json-items.mjs';

const KINDS = {
  documents: { read: readDocumentRows, change: changeDocumentRows },
  'json-items': { read: readJsonItemRows, change: changeJsonItemRows },
};

const kindOf = kind => {
  if (!Object.hasOwn(KINDS, kind)) throw Object.assign(new Error(`No row source kind ${JSON.stringify(kind)}.`), { code: 'bad_list' });
  return KINDS[kind];
};

/** One page of a source kind's rows: { rows, next }, read from the folder. */
export const readSourcePage = (kind, input) => kindOf(kind).read(input);

/** Changes a source kind's documents or items (the rows to write, or the ones to remove) in the folder. */
export function changeSourceRows(kind, input) {
  const { change } = kindOf(kind);
  if (!change) throw Object.assign(new Error(`The row source kind ${kind} has no change.`), { code: 'bad_list' });
  return change(input);
}
