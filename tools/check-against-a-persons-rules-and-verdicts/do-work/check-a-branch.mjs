// tools/check-against-a-persons-rules-and-verdicts/do-work/check-a-branch.mjs
//
// Purpose
//   The branch mode of tool:check-against-a-persons-rules-and-verdicts: one judge for every check, reading the person's
//   one Checks list by branch: one tree in one list. A branch is a node of that list of kind branch; every node names
//   the node it is part of in one link (`part_of`, read-data/branch.json `link_field`), up to a root (do-work/branch.mjs).
//   The rules of a branch are the nodes part of a branch of its lineage, plus the rows of every list a branch of it
//   names in `check_lists`. The nearest branch carrying `judge_settings` (a rule document's settings) makes the person's
//   verdict rows: its rows and the rows of the branches below it; the rows inherited from above it are generic rules. Then the existing `check`
//   (do-work/rules-and-verdicts.mjs) runs, unchanged. Ported from the old app's methods/checks.json check rows picked
//   per step and src/private-method.mjs:25 (`extends`).
//
// Non-negotiable invariants
//   1. The branch rows are read once with the door's `where { kind: branch }`, then only the rows of the branches of
//      the lineage, each with `where { part_of }`, never the whole list. A branch part of a branch is a branch below,
//      never judged: it is counted in rows_used.skipped.branch. Until the rows are rewritten, the old link fields
//      (read-data/branch.json `old_link_fields`) are read too, one `where` each; a row's parent is its first link that
//      names one, so a row read by an old field whose `part_of` names another branch is not this branch's row.
//   2. A row with `step` is a question of a decision step (tools/decide-with-a-method asks it); its `check` is question
//      text, not a judge-words check name, so it never reaches makeJudge. A row whose `on` is "Off" is not judged.
//   3. A row that states no test (none of tools/judge-words SELECTOR_NAMES, imported from there, never a second list)
//      and has no `ask` and no `part` never reaches makeJudge: one such row would refuse the whole branch. When it is
//      not a piece of a source file (`kind: "piece"`) and has words in `says`, it is a reading row: an ask row whose
//      `ask` is made from read-data/branch.json `reading` (readingRow; no word of it is in this file), carrying the
//      calibration, model and adapter of the nearest branch's `reading_settings`, so it goes to the check like any ask
//      row and no unit it reads passes without a calibrated answer. Reading rows are listed in read_by_a_model
//      ({ id, says, kind? }, at most read_by_a_model_at_most, `more` the rest, `settings_from` the branch whose
//      reading_settings they carry, or null). Any other such row is counted in rows_used.skipped.no_test; a branch with
//      only those answers status no-applicable-rule, never a refusal.
//   4. A row id is judged once: the nearest branch's row wins over an inherited row with the same id.
//   5. This file reads; it writes nothing to the person's records, and names no method, list or check of anyone: the
//      record types and words are DATA in read-data/branch.json.
//
// Shapes
//   rulesOfBranch(door, branch) -> { rules, verdict_rules | null, lineage, rows_used, read_by_a_model }
//     rows_used: { branches: { <branch id>: n }, lists: { <list id>: n }, skipped: { branch: n, step: n, off: n, no_test: n } }
//     read_by_a_model: { rows: [{ id, says, kind? }], more: n, settings_from: <branch id> | null }
//   readingRow(row, settings)   -> the row with its `ask` ({ question, options, fail, per, calibration?, model?, ... })
//   checkABranch(input, door)   -> rulesOfBranch, then check; the answer of the rules mode plus branch, lineage, rows_used,
//                                  read_by_a_model; its `questions` are one entry a rule in one page (rules-and-verdicts.mjs
//                                  askedOf; input `questions_after` the next), with questions_page and ask_all; with no row
//                                  to judge or read, status no-applicable-rule
import { lineageOf, linksOf, wheresOfLink } from './branch.mjs';
import { askedOf, check, CheckRefusal, compileVerdictRules, linesOf, statusOf } from './rules-and-verdicts.mjs';
import { SELECTOR_NAMES } from '../../judge-words/do-work/judge-words.mjs';
import SETTINGS from '../read-data/branch.json' with { type: 'json' };

const WORDS = SETTINGS.words;
const READING = SETTINGS.reading;
const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasWords = value => typeof value === 'string' && value.trim() !== '';
// The link every node names its parent in, then the old fields still read until the rows are rewritten.
const LINK = [SETTINGS.link_field, ...(SETTINGS.old_link_fields ?? [])];
const isPiece = row => row[SETTINGS.kind_field] === SETTINGS.piece_kind;
// Whether makeJudge can judge with a row: it names a judge-words selector, asks a model, or reads a part of a thing.
const statesATest = row => !isPiece(row)
  && (SELECTOR_NAMES.some(name => row[name] !== undefined) || row[SETTINGS.ask_field] !== undefined || row[SETTINGS.part_field] !== undefined);
// Whether a model can read a row that states no test: it is not a piece and it says something.
const readsAsWords = row => !isPiece(row) && hasWords(row[READING.says_field]);

/** The question a reading row asks: the parts of `reading.question`, filled from the row, joined by new lines. */
export function readingQuestion(row) {
  const says = row[READING.says_field];
  return READING.question.flatMap(part => (typeof part === 'string' ? [fill(part, row)]
    : hasWords(row[part.field]) && !says.includes(row[part.field]) ? [fill(part.text, row)] : [])).join('\n');
}

/** A row that states no test but says something, as an ask row; `settings` is the nearest branch's reading_settings. */
export function readingRow(row, settings = null) {
  const carried = Object.fromEntries(READING.carries.filter(name => settings?.[name] !== undefined).map(name => [name, settings[name]]));
  return { ...row, [SETTINGS.ask_field]: { question: readingQuestion(row), options: READING.options, fail: READING.fail, per: READING.per, ...carried } };
}

async function valuesOf(door, query) {
  const values = [];
  for await (const row of door.list(query)) if (object(row.value)) values.push(row.value);
  return values;
}

// The rows part of branch `id`: one read a field of the link, each row once, kept only when its first link names `id`.
async function rowsPartOf(door, branchRows, id) {
  const byId = new Map();
  for (const where of wheresOfLink(branchRows, LINK, id)) {
    for (const row of await valuesOf(door, { type: SETTINGS.check_type, where })) {
      if (!byId.has(row.id) && linksOf(row, LINK).includes(id)) byId.set(row.id, row);
    }
  }
  return [...byId.values()];
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
  const methods = await valuesOf(door, { type: SETTINGS.check_type, where: SETTINGS.branch_where });
  if (!methods.length) throw new CheckRefusal(WORDS.no_methods);
  let lineage;
  try { lineage = lineageOf(methods, branch, LINK); } catch (error) { throw new CheckRefusal(error.message); }
  const methodById = new Map(methods.map(row => [row.id, row]));
  const judgeAt = lineage.findIndex(id => object(methodById.get(id).judge_settings));
  const settings_from = lineage.find(id => object(methodById.get(id)[READING.settings_field])) ?? null;
  const readingSettings = settings_from === null ? null : methodById.get(settings_from)[READING.settings_field];
  const rows_used = { branches: {}, lists: {}, skipped: { branch: 0, step: 0, off: 0, no_test: 0 } };
  const seen = new Set(), rules = [], verdictRows = [], readByAModel = [];
  const take = (rows, isVerdict) => {
    for (const row of rows) {
      if (row[SETTINGS.kind_field] === SETTINGS.branch_kind) { rows_used.skipped.branch += 1; continue; }
      if (row[SETTINGS.step_field] !== undefined) { rows_used.skipped.step += 1; continue; }
      if (row[SETTINGS.on_field] === SETTINGS.off) { rows_used.skipped.off += 1; continue; }
      if (typeof row.id !== 'string' || seen.has(row.id)) continue;
      seen.add(row.id);
      let judged = row;
      if (!statesATest(row)) {
        if (!readsAsWords(row)) { rows_used.skipped.no_test += 1; continue; }
        judged = readingRow(row, readingSettings);
        readByAModel.push({ id: row.id, says: row[READING.says_field], ...(typeof row.kind === 'string' ? { kind: row.kind } : {}) });
      }
      (isVerdict ? verdictRows : rules).push(judged);
    }
  };
  const listsRead = new Set();
  for (const [at, id] of lineage.entries()) {
    const isVerdict = judgeAt >= 0 && at <= judgeAt;
    const own = (await rowsPartOf(door, methods, id))
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
  const read_by_a_model = { rows: readByAModel.slice(0, most), more: Math.max(0, readByAModel.length - most), settings_from };
  if (!rules.length && !verdictRows.length && rows_used.skipped.no_test) return { rules, verdict_rules, lineage, rows_used, read_by_a_model };
  if (!rules.length) throw new CheckRefusal(fill(WORDS.no_rules, { branch, lineage: lineage.join(' <- '), used: JSON.stringify(rows_used) }));
  return { rules, verdict_rules, lineage, rows_used, read_by_a_model };
}

/** The input of the branch mode ({ branch, units, stage?, stands?, answers?, ... }), judged by the one `check`. */
export async function checkABranch(input, door) {
  if (input.rules !== undefined || input.verdict_rules !== undefined) throw new CheckRefusal(WORDS.rules_and_branch);
  const { rules, verdict_rules, lineage, rows_used, read_by_a_model } = await rulesOfBranch(door, input.branch);
  if (!rules.length) {
    return { status: SETTINGS.no_applicable_status, passed: false, results: [], questions: [], questions_page: { rules: 0, returned: 0, next: null },
      lines: [fill(WORDS.no_applicable_rule, { branch: input.branch, lineage: lineage.join(' <- '), count: rows_used.skipped.no_test })],
      branch: input.branch, lineage, rows_used, read_by_a_model };
  }
  const verdictRules = verdict_rules === null ? null : compileVerdictRules(verdict_rules);
  const checked = check(input.units, rules, { answers: input.answers ?? {}, stands: input.stands ?? [], verdictRules,
    stage: input.stage, fieldsByKind: input.fields_by_kind ?? {}, asOf: input.stands_as_of ?? null });
  const { results } = checked;
  const status = statusOf(results);
  return { status, passed: status === 'passed', results, ...askedOf(checked.questions, results, { after: input.questions_after ?? null }), lines: linesOf(results),
    branch: input.branch, lineage, rows_used, read_by_a_model };
}
