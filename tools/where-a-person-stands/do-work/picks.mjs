// tools/where-a-person-stands/do-work/picks.mjs
//
// Purpose
//   The examples a person's picks imply, for calibrating a small model: the options they picked or rejected in a film's
//   pick ledger label that option's lines. Ported from the copy gate's pick items (source-repo-a
//   tools/copy-gate/verdicts.mjs pickItems). This file reads nothing: the caller hands in each film's pick settings, the
//   latest decision rows (read through pick-gate, the one reader of the decisions), the film's file list and, for each
//   spec matched, its copy units (the unit reader's output); a matched spec whose units were not sent is listed in
//   `units_needed`, so the caller reads it and sends again.
//
// Non-negotiable invariants
//   1. The latest decision of an option governs.
//   2. A pick says nothing about a line it does not show: an option picked labels its units good except the lines its row
//      names; an option rejected labels bad only the lines it names, while its latest row is a rejection.
//   3. Never rows in the rulings list (a pick is not a line ruling). A text ruled directly by a real person wins.
//   4. Excluded strings, texts ruled on directly and texts picks label both ways are left out and counted; a pick whose
//      spec is not found or not unique is listed, never guessed.
//   5. This file names no person, film, folder or verdict word: they arrive as input or as the person's setting.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { withSettings } from './rulings.mjs';

// A glob over relative paths: `**` any folders, `*` any characters but '/', every other character itself.
const globTest = pattern => new RegExp(`^${pattern.split(/(\*\*\/|\*\*|\*)/).map(part => (part === '**/' ? '(?:.*/)?' : part === '**' ? '.*'
  : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))).join('')}$`);
const globSync = (pattern, { cwd }) => (cwd.files ?? []).filter(file => globTest(pattern).test(file)).sort();

/** The latest decision of every option of a film, as pick-gate `rows` read them (the one reader of the decisions). */
const decisionsOf = folder => folder.decisions ?? [];

/**
 * Pick-implied labels, read from each film's pick decisions (pick-gate `rows`, latest per option wins):
 * every copy unit of an option whose latest row is one of `picked_verdicts` is `good`, except lines the row names; the
 * lines the person named when he rejected an option (the row's `lines`, or `rejected_lines` for rows older than that field;
 * applied only while that option's latest row is a rejection) are `bad`. They are
 * calibrate items with source "pick-implied", never rows in the verdict log (a pick is not a line ruling). Excluded
 * strings (his notes criticised them), texts he ruled on directly (the ruling wins) and texts that picks label both
 * ways are left out and counted; a pick whose spec is not found or not unique is listed, never guessed. A film takes
 * part when its pick-gate.json has a `pick_labels` block (spec_globs, words, exclude, rejected_lines; paths relative to
 * the film folder).
 *
 * `films` are [{ name, gate, decisions, files, units }]: `gate` the film's pick settings ({ picked_verdicts, pick_labels }),
 * `decisions` its decision rows ({ option_id, verdict, lines?, reason_verbatim? }), `files` its file paths (relative),
 * `units` { <spec path>: [{ text, kind, context? }] } for the specs read so far. `rulings` are the rulings list's rows;
 * only those by `real` carrying every field `needs` names, with a `verdicts` word, are ruled directly. `rejected` is the
 * pattern a rejecting verdict matches. Returns { items, left_out, units_needed: [{ film, spec, words?, text_keys?,
 * spoken_lead_s? }] }.
 */
export function examplesFromPicks({ films = [], rulings = [], real = ['person'], needs = [], verdicts = { bad: 'bad', good: 'good' },
  bad_label = 'real-bad', rejected = '^rejected' } = {}) {
  const ruled = new Set(rulings.filter(row => real.includes(row.by) && [verdicts.bad, verdicts.good].includes(row.verdict) && needs.every(field => row[field] != null)).map(row => row.text));
  const left_out = { excluded: 0, ruled_directly: 0, both_labels: 0, no_spec: [], several_specs: [] };
  const units_needed = [];
  const byText = new Map();
  for (const folder of films) {
    const gate = folder.gate ?? {};
    const labels = gate.pick_labels;
    if (!labels) continue;
    const latest = new Map(decisionsOf(folder).map(row => [row.option_id, row]));
    for (const [option, row] of latest) {
      // Lines his words single out: the row's own `lines` (pick_gate.py record-pick --line), else rejected_lines for older rows.
      const picked = gate.picked_verdicts.includes(row.verdict);
      const named = row.lines ? { lines: row.lines } : labels.rejected_lines?.[option];
      const label = picked ? 'good' : named && new RegExp(rejected).test(row.verdict) ? 'bad' : null;
      if (!label) continue;
      const specs = labels.spec_globs.flatMap(pattern => globSync(pattern.replaceAll('{option}', option), { cwd: folder }));
      if (specs.length !== 1) { left_out[specs.length ? 'several_specs' : 'no_spec'].push(option); continue; }
      const spec = specs[0];
      const words = Object.entries(labels.words ?? {}).find(([prefix]) => specs[0].startsWith(`${prefix}/`))?.[1];
      const units = folder.units?.[spec];
      if (!units) {
        units_needed.push({ film: folder.name, spec, ...(words ? { words } : {}), ...(labels.text_keys ? { text_keys: labels.text_keys } : {}),
          ...(labels.spoken_lead_s !== undefined ? { spoken_lead_s: labels.spoken_lead_s } : {}) });
        continue;
      }
      const excluded = new Set([...(labels.exclude?.[option] ?? []).map(entry => entry.text), ...(picked ? row.lines ?? [] : [])]);
      for (const unit of units) {
        if (label === 'bad' && !named.lines.includes(unit.text)) continue;
        if (excluded.has(unit.text)) { left_out.excluded += 1; continue; }
        if (ruled.has(unit.text)) { left_out.ruled_directly += 1; continue; }
        const item = { text: unit.text, good: label === 'good', bad_for: label === 'bad' ? [bad_label] : [], split: 'real', source: 'pick-implied',
          kind: unit.kind, film: folder.name, option, verdict: row.verdict, their_words: row.reason_verbatim ?? null, spec, context: unit.context ?? null };
        const seen = byText.get(unit.text);
        if (!seen) byText.set(unit.text, item);
        else if (seen.good !== item.good) seen.conflict = true;
      }
    }
  }
  const items = [...byText.values()].filter(item => !item.conflict);
  left_out.both_labels = byText.size - items.length;
  return { items, left_out, units_needed };
}

/** `tool:make-examples-from-picks`, run by tools/records-door run-an-export: examplesFromPicks over the setting and input. */
export const makeExamplesFromPicks = async input => examplesFromPicks(await withSettings(input));
