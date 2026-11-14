// parts/ui/show/chart/chart-choice.ts
//
// PURPOSE
//   Where a list's own chart choice is kept when no saved view carries it. The signed-in page keeps it as the person's own
//   record per list (workspace preference `chart-view:<list>`); a page that cannot keep anything (a public share) keeps none.
//   list-chart.tsx reads and writes through this seam, so the chart reaches no workspace store itself and can be bundled
//   into any page.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The default keeps nothing: a read answers null and a write does nothing, so a read-only page draws the chart its
//      saved view names and never invents a choice.
//   2. The store is set once, when the page starts (src/workspace/offer-chart.ts), before any list draws.

export type ChartChoiceStore = {
  use: <T>(key: string) => T | null;
  write: (key: string, value: unknown) => unknown;
};

let store: ChartChoiceStore = { use: () => null, write: () => undefined };

/** Keep chart choices in this store from now on (the page that can keep them calls this once). */
export function keepChartChoicesIn(next: ChartChoiceStore) {
  store = next;
}

/** The kept choice for a list, read where hooks may be called. */
export function useChartChoice<T>(key: string): T | null {
  return store.use<T>(key);
}

/** Keep a choice for a list. */
export function keepChartChoice(key: string, value: unknown) {
  return store.write(key, value);
}
