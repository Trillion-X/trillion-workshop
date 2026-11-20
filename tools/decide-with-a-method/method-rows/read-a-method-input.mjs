// tools/decide-with-a-method/method-rows/read-a-method-input.mjs
//
// The entry tool:read-a-method runs. A call either hands in the records its caller read (readAMethod, view.mjs), or hands
// in one old-store method by its rows: `method_row` (its old_store.method row) and `checklist_rows` (the checklist rows that
// hold its checks), both read by the caller's own SQL, then shaped here (store-records.mjs). The caller names the saved view
// the same way in both cases, so `method` must be the view the store rows shape into when they are given.
import { readAMethod } from './view.mjs';
import { readAMethodFromStore, recordsOfMethod } from './store-records.mjs';

export function readAMethodInput(input) {
  const { method_row: methodRow, checklist_rows: checklistRows, ...rest } = input ?? {};
  if (methodRow === undefined && checklistRows === undefined) return readAMethod(input);
  if (!methodRow || !Array.isArray(checklistRows)) throw new Error('method_row and checklist_rows are given together: the method row and its checklist rows');
  const { view } = recordsOfMethod(methodRow, checklistRows);
  if (rest.method !== undefined && rest.method !== view) throw new Error(`method ${rest.method} is not the view of method_row ${methodRow.id}, which is ${view}`);
  return readAMethodFromStore({ methodRow, checklistRows, after: rest.after, limit: rest.limit });
}
