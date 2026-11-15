// show/use-measure-engine.ts
//
// Purpose: a browser screen that totals values through `measure` (tools/query-and-change-list-rows/src/list-aggregates.mjs) asks this
// hook first. It has the formula engine's wasm fetched from where the page said it is (provideMeasureEngine, from the page's own
// cached fetch, so the 4 MB is read once for every filter and total) the first time a screen needs it, and answers true once `measure`
// can answer at once; a screen draws "no reading" until then and again as soon as it is true. In Node it is true at once.
//
// Non-Negotiable Invariants:
//   1. Nothing here totals anything; it only says when the formula engine is ready, so a screen keeps no math of its own.
//   2. The wasm is fetched at the first screen that asks, never at page load, and once for every screen of the page.
//   3. A load that failed leaves the answer false (a screen shows no reading, never a made-up one) and the next screen to ask tries again.
import { useEffect, useState } from 'react';
import { loadMeasureEngine, measureEngineReady } from 'trillion-workshop/tools/query-and-change-list-rows/src/list-aggregates.mjs';

/** `wanted: false` for a screen that has nothing to total this time: it fetches nothing (and still answers whether the engine is held). */
export function useMeasureEngine(wanted = true): boolean {
  const [ready, setReady] = useState(measureEngineReady);
  useEffect(() => {
    if (ready || !wanted) return undefined;
    let live = true;
    loadMeasureEngine().then(() => { if (live) setReady(true); }, () => {});
    return () => { live = false; };
  }, [ready, wanted]);
  return ready;
}
