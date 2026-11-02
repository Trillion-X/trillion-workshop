// tools/where-a-person-stands/do-work/rulings.mjs
//
// Purpose
//   A log of rulings on single lines (good or bad, by whom, under which rule), kept append-only, and the examples a small
//   model is calibrated on, read from it. A ruling is lighter than a stand: anyone may give one (a person, a reviewer, a
//   checker that escalated the line), and only the rulings by the people the caller names count as real. This file reads
//   and writes no file: the caller hands in the rows already in the log and appends what `freshRulings` returns.
//
// Non-negotiable invariants
//   1. Append only. A row is never edited or removed; a later ruling on the same line is a new row.
//   2. The same (text, verdict, by, rule) is written once, so running a check again does not inflate the log.
//   3. Only rulings by the people in `real` are examples. A text ruled both good and bad, or present in any `exclude`
//      list (lines a model was trained on must never calibrate it), is left out and counted, never guessed.
//   4. A bad ruling names no rule of its own, so its example carries `bad_label` in bad_for, which a model row counts only
//      when its calibration lists that label.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

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

/**
 * Calibration examples from the rulings of the people in `real`: a bad ruling is { good: false, bad_for: [bad_label] },
 * a good one { good: true, bad_for: [] }. `needs` names fields a ruling must carry to count (where it was judged, say).
 * `speech` rows (lines the person said, each with `sets`) whose sets hold `speech_set` are good examples too, unless a
 * ruling on the same text is already one. `contexts` ({ text: context }) gives each example its context, or null.
 * Returns { items, left_out: { both_rulings, in_exclude } }.
 */
export function examplesFromRulings({ rulings = [], real = ['person'], needs = [], speech = [], speech_set = 'person', exclude = [],
  bad_label = 'real-bad', contexts = {} } = {}) {
  const excluded = new Set(exclude.flat().map(row => (typeof row === 'string' ? row : row.text)));
  const byText = new Map();
  for (const row of rulings.filter(row => real.includes(row.by) && ['bad', 'good'].includes(row.verdict) && needs.every(field => row[field] != null))) {
    byText.set(row.text, new Set([...(byText.get(row.text) ?? []), row.verdict]));
  }
  const items = [], left_out = { both_rulings: 0, in_exclude: 0 };
  const context = text => (Object.hasOwn(contexts, text) ? contexts[text] : null);
  for (const [text, verdicts] of byText) {
    if (verdicts.size > 1) { left_out.both_rulings += 1; continue; }
    if (excluded.has(text)) { left_out.in_exclude += 1; continue; }
    const bad = verdicts.has('bad');
    items.push({ text, good: !bad, bad_for: bad ? [bad_label] : [], split: 'real', source: 'ruling', context: context(text) });
  }
  for (const row of speech.filter(row => row.sets?.includes(speech_set))) {
    if (excluded.has(row.text)) { left_out.in_exclude += 1; continue; }
    if (byText.has(row.text)) continue;
    items.push({ text: row.text, good: true, bad_for: [], split: 'real', source: 'speech', context: context(row.text) });
  }
  return { items, left_out };
}
