// tools/ask-a-small-model-for-a-verdict/do-work/answer-with-a-downloaded-model.mjs
//
// Purpose
//   The two Workshop rows over answer_with_a_downloaded_model.py: answer the `ask` questions a check lists (decider-2b,
//   a LoRA adapter of it, a downloaded MLX chat model, a hosted model through the consult route, or a stand-in), and
//   calibrate a person's ask rows on lines they already ruled on. Nothing is read from or written to the person's
//   records: the caller's AI reads the person's rows from their store and passes them in the request; the answer is
//   returned and kept nowhere here. The answering itself is the Python file beside this one.
//
// Non-negotiable invariants
//   1. The settings are read only through tools/settings `setting`, for this tool's folder, from `settings_record`: the
//      person's setting row as records:read gives it ({ id, type, value }), its value, or a list of them; nothing here
//      has a default for a model, a path or a bar.
//   2. A set of labelled lines is the `line_rows` the caller passes: check rows of kind `labelled-line` and that `set`,
//      in their `at` order; a labelled line's own kind of copy is kept in `copy_kind` (the row's `kind` says what the row
//      is) and handed to the answerer as `kind`, as the lines were before they moved; the row's own fields (part_of, set,
//      at, from) are not.
//   3. A rule is a check row passed whole in `rules` ({ id, value } as records:read gives it); a row with no `ask` is
//      refused, never answered.
//   4. The last line the Python prints is { result } or { error }; an error is thrown with its words.
//
//   answerAsks({ settings_record, asks, mode?, line_rows? })                                  -> [{ option: p } | null]
//   calibrateAsks({ settings_record, rules, lines, line_rows?, split?, context_only?, fpr?, mode? })
//                                                                                     -> { <rule id>: fit-lines finding }
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ID_PREFIX, setting } from '../../settings/read-data/settings.mjs';

export const TOOL = 'ask-a-small-model-for-a-verdict';
export const LINE_KIND = 'labelled-line';
const here = dirname(fileURLToPath(import.meta.url));
const ANSWERER = join(here, 'answer_with_a_downloaded_model.py');

export class AnswerRefused extends Error {}

const stemOf = path => String(path).split('/').at(-1).replace(/\.[^.]*$/, '');

const valueOf = row => (row && typeof row === 'object' && 'value' in row && 'id' in row ? row.value : row) ?? {};

/** One set of the labelled lines the caller passed, in their order, each as the answerer reads it. */
export function readLineSet(lineRows, set) {
  const lines = [];
  for (const row of lineRows) {
    const { kind, part_of, set: rowSet, at, copy_kind, from, ...line } = valueOf(row);
    if (kind !== LINE_KIND || rowSet !== set) continue;
    lines.push({ at, line: { ...line, ...(copy_kind ? { kind: copy_kind } : {}) } });
  }
  if (!lines.length) throw new AnswerRefused(`line_rows holds no labelled lines in the set ${set} (check rows with kind ${LINE_KIND} and set ${set}).`);
  return lines.sort((a, b) => a.at - b.at).map(entry => entry.line);
}

/** The sets the asks' examples name, each read once from the passed rows. */
function lineSetsFor(lineRows = [], asks, given = []) {
  const names = new Set([...given, ...asks.map(ask => ask.examples?.items).filter(Boolean).map(stemOf)]);
  const sets = {};
  for (const name of names) sets[name] = readLineSet(lineRows, name);
  return sets;
}

/** One check row passed in `rules`, with its id, refused unless it asks a model a question. */
export function askRowOf(row) {
  const id = row?.id?.replace(/^record:check:/, '');
  if (!id || !row.value) throw new AnswerRefused('each of rules is a check row as records:read gives it: { id: "record:check:<id>", value }.');
  if (!row.value.ask) throw new AnswerRefused(`The check row ${id} has no ask: only a row that asks a model a question can be calibrated.`);
  return { ...row.value, id };
}

/** Runs the Python answerer on one request and answers its result, or throws its error. */
export function runAnswerer(action, request, { python = 'python3' } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(python, ['-I', ANSWERER, action], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', fail);
    child.on('close', () => {
      const last = out.trim().split('\n').at(-1);
      let answer;
      try { answer = JSON.parse(last); } catch { return fail(new AnswerRefused(`the answerer printed no answer: ${err.trim().split('\n').at(-1) ?? ''}`)); }
      if ('error' in answer) return fail(new AnswerRefused(answer.error));
      done(answer.result);
    });
    child.stdin.end(JSON.stringify(request));
  });
}

const settingsOf = input => {
  const given = input?.settings_record;
  if (given === undefined || given === null || given === '') {
    throw new AnswerRefused(`settings_record is required: the person's setting row for this tool, ${ID_PREFIX}${TOOL}~<scope_kind>~<scope_id>, as records:read gives it`);
  }
  if (typeof given === 'string') throw new AnswerRefused(`settings_record is the setting row itself, not its id ${given}: read it from the person's settings and pass it.`);
  const found = setting(given, { folder: TOOL });
  if (found === null) throw new AnswerRefused(`settings_record holds no setting row for ${TOOL}: give the row ${ID_PREFIX}${TOOL}~<scope_kind>~<scope_id>.`);
  return found;
};

export async function answerAsks(input) {
  if (!Array.isArray(input?.asks)) throw new AnswerRefused('asks is required: [{ question, options, text, adapter?, model?, examples?, context? }], as a check lists its questions');
  const settings = settingsOf(input);
  const lineSets = lineSetsFor(input.line_rows, input.asks);
  return runAnswerer('answer', { settings, asks: input.asks, mode: input.mode ?? 'live', line_sets: lineSets });
}

export async function calibrateAsks(input) {
  if (!Array.isArray(input?.rules) || !input.rules.length) throw new AnswerRefused('rules is required: the check rows with an ask to calibrate');
  if (typeof input?.lines !== 'string') throw new AnswerRefused('lines is required: the set of labelled lines that calibrates them');
  const settings = settingsOf(input);
  const rules = input.rules.map(askRowOf);
  const lineSets = lineSetsFor(input.line_rows, rules.map(rule => rule.ask), [input.lines]);
  return runAnswerer('calibrate', {
    settings, rules, lines: lineSets[input.lines], lines_name: input.lines, line_sets: lineSets, mode: input.mode ?? 'live',
    ...(input.split !== undefined ? { split: input.split } : {}), ...(input.fpr !== undefined ? { fpr: input.fpr } : {}),
    context_only: input.context_only === true,
  });
}
