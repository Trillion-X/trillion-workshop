// rules/evaluator-bytes-in-the-page.mjs
//
// Purpose: where the row evaluator's wasm is for a browser page built by the web client (its bundler answers a `.wasm` import with the
// content-named file it writes), fetched once for everything the page works out with it: its filters (rules/filter-rows-by-rules.mjs)
// and its totals (the list engine's `measure`, tools/query-and-change-list-rows/src/list-aggregates.mjs). Only a page imports this
// file; Node reads the bytes from the folder, and a bundle that carries no page never names them.
//
// Non-Negotiable Invariants:
//   1. One fetch of the 4 MB for the whole page, whoever asks first; a failed fetch is forgotten so the next ask tries again.
//   2. Nothing is fetched at import: the totals' owner is only told how to get the evaluator from the bytes (provideMeasureEngine).
import address from '../built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm';
import { loadRowEvaluator } from './evaluate-over-rows.mjs';
import { provideMeasureEngine } from 'trillion-workshop/tools/query-and-change-list-rows/src/list-aggregates.mjs';

let fetching = null;

/** The evaluator's bytes, fetched once for every filter and total this page makes. */
export function evaluatorBytes() {
  fetching ||= fetch(address)
    .then(response => {
      if (!response.ok) throw new Error('Filters could not be loaded.');
      return response.arrayBuffer();
    })
    .then(bytes => new Uint8Array(bytes))
    .catch(error => {
      fetching = null;
      throw error;
    });
  return fetching;
}

// The totals' owner is told how to get the evaluator from those bytes; nothing is fetched until a screen has a total to work out.
provideMeasureEngine(async () => loadRowEvaluator(await evaluatorBytes()));
