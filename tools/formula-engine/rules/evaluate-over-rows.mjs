// packages/formula-engine/rules/evaluate-over-rows.mjs
//
// Purpose
//   Load the formula engine's row evaluator (../built-stored-bytes/evaluate-over-rows,
//   built by ../evaluate-over-rows/build.mjs) into any JavaScript host and give
//   it a small, JSON-shaped interface. The host supplies the wasm bytes, so the
//   same module works in a browser page, a Web Worker and a Node worker thread.
//
// Non-negotiable invariants
//   - One loaded evaluator holds ONE row table. `filterRows` replaces the table
//     and filters in one synchronous call, so two callers sharing a page can
//     never read each other's rows; `replaceRows`/`patchRows`/`filter` are for a
//     host that owns the evaluator alone (a worker) and keeps its rows loaded.
//   - A null binding means "no rule", so every row matches.
//   - Errors from the evaluator are thrown as Error with the evaluator's words.
//   - Every evaluation passes the guards (evaluation-guards.mjs, limits in
//     evaluation-guards.json) first: depth, size, cycles, patterns and work are
//     checked before the evaluator sees the binding, and rows are given to it a
//     slice at a time so a call past its time budget stops between slices.

import {initSync, replace_rows, patch_rows, filter_rows, evaluate} from '../built-stored-bytes/evaluate-over-rows/evaluate-over-rows.js';
import {checkBinding, checkWork, inSlices, noteTime, refuseIfSlow} from './evaluation-guards.mjs';

const call = (fn, request) => {
  try {
    return JSON.parse(fn(JSON.stringify(request)));
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
};

let loaded = false;

/** Instantiate the evaluator once from its wasm bytes. */
export function loadRowEvaluator(wasmBytes) {
  if (!loaded) {
    initSync({module: wasmBytes});
    loaded = true;
  }
  let length = 0;
  const everyRow = () => Array.from({length}, (_, index) => index);
  return {
    replaceRows(rows) {
      length = call(replace_rows, rows).length;
      return length;
    },
    patchRows(patch) {
      length = call(patch_rows, patch).length;
      return length;
    },
    /** Indices of loaded rows the binding holds for, plus any evaluation error. */
    filter(binding) {
      if (!binding) return {matches: everyRow(), errorRows: 0, firstError: null};
      checkWork(checkBinding(binding).weight, length);
      refuseIfSlow(binding);
      const started = globalThis.performance?.now?.() ?? Date.now();
      const reply = call(filter_rows, {binding});
      noteTime(binding, started);
      return {matches: reply.matches, errorRows: reply.error_rows, firstError: reply.first_error};
    },
    /** Replace the table with `rows` and filter it, a slice of rows at a time (evaluation-guards.json rows_per_slice). */
    filterRows(rows, binding) {
      if (!binding) {
        this.replaceRows(rows);
        return {matches: everyRow(), errorRows: 0, firstError: null};
      }
      checkWork(checkBinding(binding).weight, rows.length);
      refuseIfSlow(binding);
      return inSlices(binding, rows, slice => {
        this.replaceRows(slice);
        const reply = call(filter_rows, {binding});
        return {matches: reply.matches, errorRows: reply.error_rows, firstError: reply.first_error};
      });
    },
    evaluate(binding, input) {
      checkWork(checkBinding(binding).weight, 1);
      refuseIfSlow(binding);
      const started = globalThis.performance?.now?.() ?? Date.now();
      const value = call(evaluate, {binding, input}).value;
      noteTime(binding, started);
      return value;
    },
  };
}
