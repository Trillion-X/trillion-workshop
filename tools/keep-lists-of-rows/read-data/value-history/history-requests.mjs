// tools/keep-lists-of-rows/read-data/value-history/history-requests.mjs
//
// The two Workshop rows of a list field's history (tool:work-out-history-values, tool:read-a-fields-history), each a
// function of its request run by tools/workflows/do-work/run-a-function.mjs. Each refuses what it cannot run with a
// sentence that says what to send. Moved unchanged from tools/formulas/do-work/requests.mjs when the formula engine's
// Rust module replaced that folder: the history arithmetic is the lists' own (list-value-history.mjs).
import { checkHistoryFields, fieldHistoryOf, historyValues } from './list-value-history.mjs';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const need = (ok, sentence) => { if (!ok) throw new Error(sentence); };

/**
 * The values of a row's history fields, worked out from the steps its history-keeping fields kept: value_at,
 * previous_value, value_set_at, time_spent_in, has_been_in. now_ms is the moment the answers are as of.
 */
export function historyFieldValues(request) {
  need(isObject(request), 'Send an object with fields (history fields) and kept (the row, with its _history).');
  need(Array.isArray(request.fields) && request.fields.every(field => isObject(field) && typeof field.id === 'string'), 'fields must be a list of { id, kind: "history", history: { field, op, value?, at?, days_ago?, unit? } }.');
  need(Number.isFinite(request.now_ms), 'now_ms must be the moment, in milliseconds, the answers are as of.');
  const fields = request.fields.map(field => ({ kind: 'history', ...field }));
  if (request.check !== false) checkHistoryFields([...(request.kept_fields ?? fields.map(field => ({ id: field.history?.field, keeps_history: true }))), ...fields]);
  return { values: historyValues(isObject(request.kept) ? request.kept : null, fields, request.now_ms) };
}

/** One field's history of one row as lines a person reads: who changed it, by which road, from when until when. */
export function fieldHistory(request) {
  need(isObject(request) && isObject(request.list) && Array.isArray(request.list.fields), 'Send list { fields }, row_id, field_id and kept (the row, with its _history).');
  return fieldHistoryOf(request.list, request.list.id ?? null, request.row_id ?? null, isObject(request.kept) ? request.kept : null, request.field_id);
}
