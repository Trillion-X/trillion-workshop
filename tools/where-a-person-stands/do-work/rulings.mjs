// tools/where-a-person-stands/do-work/rulings.mjs
//
// Purpose
//   The examples a small model is calibrated on, read from the rulings on single lines (good or bad, by whom, under which
//   rule) kept as rows of a list in the person's own account (do-work/ruling-records.mjs keeps them). A ruling is lighter
//   than a stand: anyone may give one (a person, a reviewer, a checker that escalated the line), and only the rulings by
//   the people the caller names count as real. This file reads and writes no file: the caller hands in the rows it read
//   back from the list. `withSettings` puts the person's setting for this tool (their row of list:settings, read by
//   tools/settings) under the input of every rulings tool.
//
// Non-negotiable invariants
//   1. Nothing here edits or removes a ruling; a later ruling on the same line is its own row (ruling-records.mjs).
//   2. The people, the verdict words, the bad label and the fields a ruling needs arrive as input or as the person's
//      setting; this file names no person, film or folder.
//   3. Only rulings by the people in `real` are examples. A text ruled both good and bad, or present in any `exclude`
//      list (lines a model was trained on must never calibrate it), is left out and counted, never guessed.
//   4. A bad ruling names no rule of its own, so its example carries `bad_label` in bad_for, which a model row counts only
//      when its calibration lists that label.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { setting } from '../../settings/read-data/settings.mjs';

export const TOOL = 'where-a-person-stands';

/**
 * The input with the person's setting under it: `settings_record` is their row of list:settings for this tool
 * (record:setting:where-a-person-stands~<scope kind>~<scope id>) as the caller read it with records:read (the record, its
 * value, or a list of them), read by the one shared reader, tools/settings `setting`. The input's own fields win over the
 * setting's. Without settings_record the input is used as it is.
 */
export async function withSettings(input = {}) {
  const { settings_record, ...given } = input ?? {};
  const out = settings_record === undefined ? given : { ...setting(settings_record, { folder: TOOL, fallback: {} }), ...given };
  return Array.isArray(out.rulings) ? { ...out, rulings: asRulings(out.rulings) } : out;
}

// A ruling kept in list:checks (labelled-line or escalated-line) has its copy kind as line_kind; read back, it is kind again.
const KEPT = new Set(['labelled-line', 'escalated-line']);
/** Rulings read back from list:checks (records or their values) as rulings; any other row is passed as it is. */
export const asRulings = (rows = []) => rows.map(row => (row && typeof row === 'object' && 'value' in row && 'type' in row ? row.value : row))
  .filter(Boolean).map(({ line_kind, part_of, ...row }) => (KEPT.has(row.kind) ? { ...row, kind: line_kind } : { line_kind, part_of, ...row }))
  .map(row => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)));

/**
 * Calibration examples from the rulings of the people in `real`: a bad ruling is { good: false, bad_for: [bad_label] },
 * a good one { good: true, bad_for: [] } (`verdicts` names the two words, default bad and good). `needs` names fields a ruling must carry to count (where it was judged, say).
 * `speech` rows (lines the person said, each with `sets`) whose sets hold `speech_set` are good examples too, unless a
 * ruling on the same text is already one. `contexts` ({ text: context }) gives each example its context, or null.
 * Returns { items, left_out: { both_rulings, in_exclude } }.
 */
export function examplesFromRulings({ rulings = [], real = ['person'], needs = [], speech = [], speech_set = 'person', exclude = [],
  bad_label = 'real-bad', contexts = {}, verdicts = { bad: 'bad', good: 'good' } } = {}) {
  const excluded = new Set(exclude.flat().map(row => (typeof row === 'string' ? row : row.text)));
  const byText = new Map();
  for (const row of rulings.filter(row => real.includes(row.by) && [verdicts.bad, verdicts.good].includes(row.verdict) && needs.every(field => row[field] != null))) {
    byText.set(row.text, new Set([...(byText.get(row.text) ?? []), row.verdict]));
  }
  const items = [], left_out = { both_rulings: 0, in_exclude: 0 };
  const context = text => (Object.hasOwn(contexts, text) ? contexts[text] : null);
  for (const [text, given] of byText) {
    if (given.size > 1) { left_out.both_rulings += 1; continue; }
    if (excluded.has(text)) { left_out.in_exclude += 1; continue; }
    const bad = given.has(verdicts.bad);
    items.push({ text, good: !bad, bad_for: bad ? [bad_label] : [], split: 'real', source: 'ruling', context: context(text) });
  }
  for (const row of speech.filter(row => row.sets?.includes(speech_set))) {
    if (excluded.has(row.text)) { left_out.in_exclude += 1; continue; }
    if (byText.has(row.text)) continue;
    items.push({ text: row.text, good: true, bad_for: [], split: 'real', source: 'speech', context: context(row.text) });
  }
  return { items, left_out };
}

/** `tool:make-examples-from-rulings`, run by tools/records-door run-an-export: examplesFromRulings over the setting and input. */
export const makeExamplesFromRulings = async input => examplesFromRulings(await withSettings(input));
