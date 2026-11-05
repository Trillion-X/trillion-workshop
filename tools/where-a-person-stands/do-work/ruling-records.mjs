const keyOf = row => JSON.stringify([row.text, row.verdict, row.by, row.rule ?? null]);

/** The rows of `rows` not already in `existing`, each stamped `at` (unless it has its own): what to append to the log. */
export function freshRulings(existing, rows, { at = new Date().toISOString() } = {}) {
  const seen = new Set(existing.map(keyOf));
  const fresh = [];
  for (const row of rows) {
    const full = { at, ...row };
    if (seen.has(keyOf(full))) continue;
    seen.add(keyOf(full));
    fresh.push(full);
  }
  return fresh;
}
