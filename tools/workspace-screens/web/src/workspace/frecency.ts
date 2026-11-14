// src/workspace/frecency.ts
//
// PURPOSE
//   Frecency for Find anything (src/workspace/command-palette.tsx): how much a result is used and how lately, kept as ONE
//   number per result, not a visit table. The number is an "equivalent date": the moment at which a single visit would
//   weigh what all the real visits weigh together, so ordering by it is ordering by decayed use, and one visit moves it
//   forward by an amount that shrinks the more recently the result was already used.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One date per address; no visit log. weight(date, now) = 2^((date - now) / half_life), always in (0, 1].
//   2. Changing the half-life is a migration: every kept date is moved so each result keeps the weight it has now under
//      the new half-life (rescale), never left to mean something different.
//   3. The words typed that led to a pick are kept per address (bounded), so the same words find the pick again.
//   4. Every number that varies (half-life, bounds, bonuses) is a row in command-palette.json `frecency`.
//   5. The store is the device's: nothing here leaves it.
export type FrecencyRules = { half_life_days: number; store_key: string; max_items: number; max_terms: number; bonus: number; term_bonus: number };
export type Kept = { half_life_days: number; items: Record<string, { date: number; terms: string[] }> };
export type Store = { read(key: string): string | null; write(key: string, value: string): void };

const DAY = 86_400_000;
const lambda = (days: number) => Math.LN2 / (days * DAY);

/** The weight of a result at `now`: 1 for one visit this instant, halving every half-life after. */
export const weight = (date: number, now: number, days: number) => Math.exp(Math.min(0, lambda(days) * (date - now)));

/** Adds one visit at `now` to a date: the log-sum of two equal-scale weights, expressed back as a date. */
export function visited(date: number | undefined, now: number, days: number): number {
  if (date === undefined) return now;
  const high = Math.max(date, now), low = Math.min(date, now);
  return high + Math.log1p(Math.exp(-lambda(days) * (high - low))) / lambda(days);
}

/** Every date moved so its weight at `now` is what it was under the earlier half-life. */
export function rescaled(kept: Kept, days: number, now: number): Kept {
  if (kept.half_life_days === days) return kept;
  const items = Object.fromEntries(Object.entries(kept.items).map(([address, item]) =>
    [address, { ...item, date: now - (now - item.date) * (days / kept.half_life_days) }]));
  return { half_life_days: days, items };
}

const empty = (days: number): Kept => ({ half_life_days: days, items: {} });

export function readKept(store: Store, rules: FrecencyRules, now: number): Kept {
  try {
    const parsed = JSON.parse(store.read(rules.store_key) ?? 'null') as Kept | null;
    if (parsed && typeof parsed === 'object' && parsed.items && Number.isFinite(parsed.half_life_days) && parsed.half_life_days > 0) return rescaled(parsed, rules.half_life_days, now);
  } catch { /* an unreadable store starts empty */ }
  return empty(rules.half_life_days);
}

/** Records that `address` was chosen, after the words `terms` (may be empty); keeps the most used `max_items`. */
export function recordPick(store: Store, rules: FrecencyRules, address: string, terms: string, now: number): Kept {
  const kept = readKept(store, rules, now);
  const earlier = kept.items[address];
  const word = terms.trim().toLocaleLowerCase();
  const seen = earlier?.terms ?? [];
  const nextTerms = word ? [word, ...seen.filter(item => item !== word)].slice(0, rules.max_terms) : seen;
  kept.items[address] = { date: visited(earlier?.date, now, rules.half_life_days), terms: nextTerms };
  const entries = Object.entries(kept.items);
  if (entries.length > rules.max_items) kept.items = Object.fromEntries(entries.sort((a, b) => b[1].date - a[1].date).slice(0, rules.max_items));
  store.write(rules.store_key, JSON.stringify(kept));
  return kept;
}

/** The score added to a result: its decayed use, and more when these words are ones that led to it before. */
export function bonusFor(kept: Kept, rules: FrecencyRules, address: string, query: string, now: number): number {
  const item = kept.items[address];
  if (!item) return 0;
  const words = query.trim().toLocaleLowerCase();
  const led = words.length > 0 && item.terms.some(term => term.startsWith(words));
  return rules.bonus * weight(item.date, now, kept.half_life_days) + (led ? rules.term_bonus : 0);
}
