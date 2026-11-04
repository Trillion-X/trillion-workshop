// tools/check-against-a-persons-rules-and-verdicts/do-work/check-a-branch.mjs
//
// Purpose
//   The branch mode of tool:check-against-a-persons-rules-and-verdicts: one judge for every check, reading the person's
//   one Checks list by branch. A branch is one of their method rows (list:methods); it `extends` another, up to a base
//   (do-work/branch.mjs). The rules of a branch are the check rows (list:checks) whose `method` is a branch of its
//   lineage, plus the rows of every list a branch of it names in `check_lists`. The nearest branch carrying
//   `judge_settings` (a rule document's settings) makes the person's verdict rows: its rows and the rows of the branches
//   that extend it; the rows inherited from above it are generic rules. Then the existing `check`
//   (do-work/rules-and-verdicts.mjs) runs, unchanged. Ported from the old app's methods/checks.json check rows picked
//   per step and src/private-method.mjs:25 (`extends`).
//
// Non-negotiable invariants
//   1. Only the branches of the lineage are read: each with the door's `where { method }`, never the whole list.
//   2. A row with `step` is a question of a decision step (tools/decide-with-a-method asks it); its `check` is question
//      text, not a judge-words check name, so it never reaches makeJudge. A row whose `on` is "Off" is not judged.
//   3. A row that states no test (none of tools/judge-words SELECTOR_NAMES, imported from there, never a second list),
//      has no `ask` and no `part`, or is a piece of a source file (`kind: "piece"`), never reaches makeJudge: one such
//      row would refuse the whole branch. It is counted in rows_used.skipped.no_test and listed in read_by_a_model
//      ({ id, says, kind? }, at most read_by_a_model_at_most of read-data/branch.json, `more` the rest). A branch with
//      only such rows answers status no-applicable-rule, never a refusal.
//   4. A row id is judged once: the nearest branch's row wins over an inherited row with the same id.
//   5. This file reads; it writes nothing to the person's records, and names no method, list or check of anyone: the
//      record types and words are DATA in read-data/branch.json.
//
// Shapes
//   rulesOfBranch(door, branch) -> { rules, verdict_rules | null, lineage, rows_used, read_by_a_model }
//     rows_used: { branches: { <method id>: n }, lists: { <list id>: n }, skipped: { step: n, off: n, no_test: n } }
//     read_by_a_model: { rows: [{ id, says, kind? }], more: n }
//   checkABranch(input, door)   -> rulesOfBranch, then check; the answer of the rules mode plus branch, lineage, rows_used,
//                                  read_by_a_model; with only rows that state no test, status no-applicable-rule
import { lineageOf } from './branch.mjs';
import { check, CheckRefusal, compileVerdictRules, linesOf, statusOf } from './rules-and-verdicts.mjs';
import { SELECTOR_NAMES } from '../../judge-words/do-work/judge-words.mjs';
import SETTINGS from '../read-data/branch.json' with { type: 'json' };

const WORDS = SETTINGS.words;
const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Whether makeJudge can judge with a row: it names a judge-words selector, asks a model, or reads a part of a thing.
const statesATest = row => row[SETTINGS.kind_field] !== SETTINGS.piece_kind
  && (SELECTOR_NAMES.some(name => row[name] !== undefined) || row[SETTINGS.ask_field] !== undefined || row[SETTINGS.part_field] !== undefined);

async function valuesOf(door, query) {
  const values = [];
  for await (const row of door.list(query)) if (object(row.value)) values.push(row.value);
  return values;
}

// A list a branch names: `list:<id>` or its bare id, read as the list record, then its rows by its row type.
async function rowsOfList(door, method, listId) {
  const id = listId.startsWith(SETTINGS.list_prefix) ? listId : `${SETTINGS.list_prefix}${listId}`;
  const list = await door.read(SETTINGS.list_type, id);
  if (!object(list) || typeof list.row_type !== 'string') throw new CheckRefusal(fill(WORDS.check_list_missing, { method, list: id }));
  if (!SETTINGS.check_list_row_types.includes(list.row_type)) {
    throw new CheckRefusal(fill(WORDS.check_list_row_type, { method, list: id, row_type: list.row_type, allowed: SETTINGS.check_list_row_types.join(', ') }));
  }
  return { id, rows: await valuesOf(door, { type: `record:${list.row_type}` }) };
}

/** The rules and the person's rule document of one branch, read from their records through `door`. */
export async function rulesOfBranch(door, branch) {
  if (typeof branch !== 'string' || !branch.trim()) throw new CheckRefusal(WORDS.branch);
  const methods = await valuesOf(door, { type: SETTINGS.method_type });
  if (!methods.length) throw new CheckRefusal(WORDS.no_methods);
  let lineage;
  try { lineage = lineageOf(methods, branch); } catch (error) { throw new CheckRefusal(error.message); }
  const methodById = new Map(methods.map(row => [row.id, row]));
  const judgeAt = lineage.findIndex(id => object(methodById.get(id).judge_settings));
  const rows_used = { branches: {}, lists: {}, skipped: { step: 0, off: 0, no_test: 0 } };
  const seen = new Set(), rules = [], verdictRows = [], readByAModel = [];
  const take = (rows, isVerdict) => {
    for (const row of rows) {
      if (row[SETTINGS.step_field] !== undefined) { rows_used.skipped.step += 1; continue; }
      if (row[SETTINGS.on_field] === SETTINGS.off) { rows_used.skipped.off += 1; continue; }
      if (typeof row.id !== 'string' || seen.has(row.id)) continue;
      seen.add(row.id);
      if (!statesATest(row)) {
        rows_used.skipped.no_test += 1;
        readByAModel.push({ id: row.id, says: typeof row.says === 'string' ? row.says : null, ...(typeof row.kind === 'string' ? { kind: row.kind } : {}) });
        continue;
      }
      (isVerdict ? verdictRows : rules).push(row);
    }
  };
  const listsRead = new Set();
  for (const [at, id] of lineage.entries()) {
    const isVerdict = judgeAt >= 0 && at <= judgeAt;
    const own = (await valuesOf(door, { type: SETTINGS.check_type, where: { [SETTINGS.branch_field]: id } }))
      .sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
    rows_used.branches[id] = own.length;
    take(own, isVerdict);
    for (const listId of methodById.get(id).check_lists ?? []) {
      if (listsRead.has(listId)) continue;
      listsRead.add(listId);
      const list = await rowsOfList(door, id, listId);
      rows_used.lists[list.id] = list.rows.length;
      take(list.rows, isVerdict);
    }
  }
  const verdict_rules = judgeAt >= 0 ? { ...methodById.get(lineage[judgeAt]).judge_settings, rows: verdictRows } : null;
  const most = SETTINGS.read_by_a_model_at_most;
  const read_by_a_model = { rows: readByAModel.slice(0, most), more: Math.max(0, readByAModel.length - most) };
  if (!rules.length && !verdictRows.length && readByAModel.length) return { rules, verdict_rules, lineage, rows_used, read_by_a_model };
  if (!rules.length) throw new CheckRefusal(fill(WORDS.no_rules, { branch, lineage: lineage.join(' <- '), used: JSON.stringify(rows_used) }));
  return { rules, verdict_rules, lineage, rows_used, read_by_a_model };
}

/** The input of the branch mode ({ branch, units, stage?, stands?, answers?, ... }), judged by the one `check`. */
export async function checkABranch(input, door) {
  if (input.rules !== undefined || input.verdict_rules !== undefined) throw new CheckRefusal(WORDS.rules_and_branch);
  const { rules, verdict_rules, lineage, rows_used, read_by_a_model } = await rulesOfBranch(door, input.branch);
  if (!rules.length) {
    const count = read_by_a_model.rows.length + read_by_a_model.more;
    return { status: SETTINGS.no_applicable_status, passed: false, results: [], questions: [],
      lines: [fill(WORDS.no_applicable_rule, { branch: input.branch, lineage: lineage.join(' <- '), count })],
      branch: input.branch, lineage, rows_used, read_by_a_model };
  }
  const verdictRules = verdict_rules === null ? null : compileVerdictRules(verdict_rules);
  const { results, questions } = check(input.units, rules, { answers: input.answers ?? {}, stands: input.stands ?? [], verdictRules,
    stage: input.stage, fieldsByKind: input.fields_by_kind ?? {}, asOf: input.stands_as_of ?? null });
  const status = statusOf(results);
  return { status, passed: status === 'passed', results, questions, lines: linesOf(results), branch: input.branch, lineage, rows_used, read_by_a_model };
}
