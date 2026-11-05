// tools/ask-a-small-model-for-a-verdict/do-work/answer-with-a-downloaded-model.mjs
//
// Purpose
//   The two Workshop rows over answer_with_a_downloaded_model.py: answer the `ask` questions a check lists (decider-2b,
//   a LoRA adapter of it, a downloaded MLX chat model, a hosted model through the consult route, or a stand-in), and
//   calibrate a person's ask rows on lines they already ruled on. Everything personal is read at run time through the
//   person's records door: their setting row (list:settings, through tools/settings), their ask rows and their labelled
//   lines (both rows of their one Checks list, list:checks). The answering itself is the Python file beside this one.
//
// Non-negotiable invariants
//   1. The settings are read only through tools/settings readSettings, for this tool's folder; nothing here has a default
//      for a model, a path or a bar.
//   2. A set of labelled lines is the person's Checks rows of kind `labelled-line` and that `set`, in their `at` order; a
//      labelled line's own kind of copy is kept in `copy_kind` (the row's `kind` says what the row is) and handed to the
//      answerer as `kind`, as the lines were before they moved; the row's own fields (part_of, set, at, from) are not.
//   3. An ask row is read by its id (record:check:<id>); a row with no `ask` is refused, never answered.
//   4. The last line the Python prints is { result } or { error }; an error is thrown with its words.
//
//   answerAsks({ settings_record, asks, mode?, line_sets? }, { door })                 -> [{ option: p } | null]
//   calibrateAsks({ settings_record, rules, lines, split?, context_only?, fpr?, mode?, line_sets? }, { door })
//                                                                                     -> { <rule id>: fit-lines finding }
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSettings } from '../../settings/read-data/settings.mjs';

export const TOOL = 'ask-a-small-model-for-a-verdict';
export const CHECK_TYPE = 'record:check';
export const LINE_KIND = 'labelled-line';
const here = dirname(fileURLToPath(import.meta.url));
const ANSWERER = join(here, 'answer_with_a_downloaded_model.py');

export class AnswerRefused extends Error {}

const stemOf = path => String(path).split('/').at(-1).replace(/\.[^.]*$/, '');

/** One set of the person's labelled lines, in their order, each as the answerer reads it. */
export async function readLineSet(door, set) {
  const lines = [];
  for await (const record of door.list({ type: CHECK_TYPE, where: { kind: LINE_KIND, set } })) {
    const { kind, part_of, set: _set, at, copy_kind, from, ...line } = record.value ?? {};
    lines.push({ at, line: { ...line, ...(copy_kind ? { kind: copy_kind } : {}) } });
  }
  if (!lines.length) throw new AnswerRefused(`The person has no labelled lines in the set ${set} (rows of list:checks with kind ${LINE_KIND} and set ${set}).`);
  return lines.sort((a, b) => a.at - b.at).map(entry => entry.line);
}

/** The sets the asks' examples name, read once each. */
async function lineSetsFor(door, asks, given = []) {
  const names = new Set([...given, ...asks.map(ask => ask.examples?.items).filter(Boolean).map(stemOf)]);
  const sets = {};
  for (const name of names) sets[name] = await readLineSet(door, name);
  return sets;
}

/** One of the person's ask rows by its id. */
export async function readAskRow(door, id) {
  const value = await door.read(CHECK_TYPE, `${CHECK_TYPE}:${id}`);
  if (!value) throw new AnswerRefused(`There is no check row ${id} (record:check:${id}) in the person's Checks list.`);
  if (!value.ask) throw new AnswerRefused(`The check row ${id} has no ask: only a row that asks a model a question can be calibrated.`);
  return { ...value, id };
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

const settingsOf = async (input, door) => {
  if (typeof input?.settings_record !== 'string') {
    throw new AnswerRefused(`settings_record is required: the id of the person's setting row for this tool, record:setting:${TOOL}~<scope_kind>~<scope_id>`);
  }
  return readSettings(door, input.settings_record, { tool: TOOL });
};

export async function answerAsks(input, { door } = {}) {
  if (!Array.isArray(input?.asks)) throw new AnswerRefused('asks is required: [{ question, options, text, adapter?, model?, examples?, context? }], as a check lists its questions');
  const settings = await settingsOf(input, door);
  const lineSets = await lineSetsFor(door, input.asks, input.line_sets ?? []);
  return runAnswerer('answer', { settings, asks: input.asks, mode: input.mode ?? 'live', line_sets: lineSets });
}

export async function calibrateAsks(input, { door } = {}) {
  if (!Array.isArray(input?.rules) || !input.rules.length) throw new AnswerRefused('rules is required: the ids of the check rows with an ask to calibrate');
  if (typeof input?.lines !== 'string') throw new AnswerRefused('lines is required: the set of labelled lines that calibrates them');
  const settings = await settingsOf(input, door);
  const rules = [];
  for (const id of input.rules) rules.push(await readAskRow(door, id));
  const lineSets = await lineSetsFor(door, rules.map(rule => rule.ask), [input.lines, ...(input.line_sets ?? [])]);
  return runAnswerer('calibrate', {
    settings, rules, lines: lineSets[input.lines], lines_name: input.lines, line_sets: lineSets, mode: input.mode ?? 'live',
    ...(input.split !== undefined ? { split: input.split } : {}), ...(input.fpr !== undefined ? { fpr: input.fpr } : {}),
    context_only: input.context_only === true,
  });
}
