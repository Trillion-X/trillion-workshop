// tools/where-a-person-stands/do-work/ruling-status.mjs
//
// Purpose
//   How many real bad rulings there are against the number a model row needs before it may fail lines, and how many of
//   them each model row catches. Ported from the copy gate's status (source-repo-a tools/copy-gate/verdicts.mjs
//   status). It runs no check and no model: called with the rulings alone it names the real bad lines to check
//   (`bad_lines`); called again with the check's `results` on those lines it counts what each row catches.
//
// Non-negotiable invariants
//   1. A real bad ruling is counted once per text, only by the people in `real` and only when it carries every field
//      `needs` names.
//   2. A line is caught by a row only when its own answer reaches that row's t_fail, never because the row is uncertain
//      for another reason.
//   3. The number needed, the real people and the verdict word are the person's setting; this file names none.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { withSettings } from './rulings.mjs';

/**
 * Real bad rulings, and how many of them each model row escalates. `rulings` are the rulings list's rows; `rules` the
 * model rows ({ id, ask: { calibration: { t_fail } } }, as the person's check rows keep them); `results` the check's
 * results on `bad_lines` ([{ text, uncertain: [{ rule, p_fail }] }]). Returns { real_bad_film, needed, promotion_allowed,
 * counts, bad_lines } and, with results, { escalated_by_any, per_rule, unanswered }. real_bad_film is the number of real
 * bad rulings, under the name the copy gate's count always gave it.
 */
export function rulingStatus({ rulings = [], real = ['person'], needs = [], needed = 0, verdict = 'bad', default_kind = 'line', rules = [], results = null } = {}) {
  const rows = rulings;
  const bad = [...new Map(rows.filter(row => real.includes(row.by) && row.verdict === verdict && needs.every(field => row[field] != null))
    .map(row => [row.text, { text: row.text, kind: row.kind ?? default_kind, where: row.where ?? row[needs[0]] ?? null, also_at: [] }])).values()];
  const status = {
    real_bad_film: bad.length,
    needed,
    promotion_allowed: bad.length >= needed,
    counts: Object.fromEntries([...new Set(rows.map(row => `${row.by} ${row.verdict}`))].map(k => [k, rows.filter(row => `${row.by} ${row.verdict}` === k).length])),
    bad_lines: bad,
  };
  if (!Array.isArray(results)) return status;
  // A line is caught only when the decider's own answer reaches the row's t_fail, not when the row is uncertain for
  // another reason (no qualification status yet), which would count every answered line.
  const tFail = new Map(rules.map(rule => [rule.id, rule.ask?.calibration?.t_fail ?? rule.t_fail]));
  const hit = u => u.p_fail !== null && typeof tFail.get(u.rule) === 'number' && u.p_fail >= tFail.get(u.rule);
  const caught = rule => results.filter(r => r.uncertain.some(u => u.rule === rule && hit(u))).length;
  return {
    ...status,
    escalated_by_any: results.filter(r => r.uncertain.some(hit)).length,
    per_rule: Object.fromEntries(rules.map(rule => [rule.id, caught(rule.id)])),
    unanswered: results.filter(r => r.uncertain.some(u => u.p_fail === null)).length,
  };
}

/** `tool:count-real-rulings`, run by tools/records-door run-an-export: rulingStatus over the setting and input. */
export const countRealRulings = async input => rulingStatus(await withSettings(input));
