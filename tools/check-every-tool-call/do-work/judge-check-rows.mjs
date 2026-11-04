#!/usr/bin/env node
// tools/check-every-tool-call/do-work/judge-check-rows.mjs
//
// Purpose
//   Judges what one tool call would publish against the person's check rows (their one list `list:checks`, records
//   `record:check:<id>`, kind `check`), with the one judge: tools/check-against-a-persons-rules-and-verdicts
//   do-work/rules-and-verdicts.mjs `check`, in its rules mode, imported here and never copied. `check_switches.py run`
//   reads the rows (settings `types`, the door's `where`), keeps the rows whose `kinds` name the call's unit kind, and
//   starts this file with them.
//
//   Units, by kind:
//     - git-commit: each added line of each staged file ({ kind, text, where: file, line }), and each staged JSON
//       file's whole new value ({ kind, view, where: file });
//     - git-push: the same over the commits being pushed (from where HEAD left origin/main);
//     - tool-call: the call itself ({ kind, view: { tool_name, tool_input }, where: tool name }) and each string of
//       its input as text.
//   A row that reads words judges the text units; a row that reads a value (`path`, `evidence`) judges the views.
//
//   A row's `fixtures` ({ pass: [...], refuse: [...] }) are its tests: each pass fixture must pass the row alone, and
//   each refuse fixture must be refused by it. A fixture is a text, { text } or { view }; a text given to a row that
//   reads a value is placed at the row's path (each `*` a key named by read-data/check-rows.json `fixture_key`, each
//   `**` nothing). `fixturesHold` judges them; the row `tool:check-a-check-rows-fixtures` answers it for rows a person
//   is about to write, and every hook call refuses a call whose input writes a check row whose fixtures do not hold.
//
// Non-negotiable invariants
//   1. One judge. Every finding comes from `check` (rules-and-verdicts.mjs) and every test from tools/judge-words;
//      this file names no rule, word, path, literal or person. What is judged is the rows' DATA.
//   2. A failed unit refuses the call (exit 2) with each finding's `says`. A row that states no test (none of
//      judge-words SELECTOR_NAMES) is read by a model only: it is said, never refused. A row marked Off is not judged,
//      and that is said.
//   3. A row whose fixtures do not hold is said on every call it is kept for, and still judged; a row that cannot be
//      compiled is said and not judged. Nothing here makes a check pass on silence: a call this file cannot judge
//      exits 1, which the runner says and does not refuse.
//   4. Every word said is DATA in read-data/check-rows.json.
//
// Run
//   node judge-check-rows.mjs hook --root <checkout> --kind <git-commit|git-push|tool-call> < { rows, event }
//   node judge-check-rows.mjs fixtures < { rows }        (tool:check-a-check-rows-fixtures; prints { result })
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { text as readAll } from 'node:stream/consumers';
import { check } from '../../check-against-a-persons-rules-and-verdicts/do-work/rules-and-verdicts.mjs';
import { SELECTOR_NAMES, makeJudge, stringsIn } from '../../judge-words/do-work/judge-words.mjs';
import DATA from '../read-data/check-rows.json' with { type: 'json' };

const W = DATA.words;
const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const JSON_FILE = new RegExp(DATA.json_file);

/** A row states a test when it names one of judge-words' selectors; any other row is read by a model only. */
export const statesATest = row => SELECTOR_NAMES.some(name => row?.[name] !== undefined);
const readsValue = row => row.path !== undefined || row.evidence !== undefined;
export const isOff = row => row?.[DATA.on_field] === DATA.off;

/** The rows a call of this unit kind keeps: those whose `kinds` name it. */
export const rowsFor = (rows, kind) => rows.filter(row => Array.isArray(row?.kinds) && row.kinds.includes(kind));

/** { usable, broken: [{ id, why }] }: the rows judge-words can compile, and why each other one cannot be. */
export function compiled(rows) {
  const usable = [], broken = [];
  for (const row of rows) {
    try {
      makeJudge([row]);
      usable.push(row);
    } catch (error) {
      broken.push({ id: row.id, why: String(error?.message ?? error) });
    }
  }
  return { usable, broken };
}

/** Every finding that fails a unit: { rule, where, line?, found, says }. Word rows judge texts; value rows judge views. */
export function judgeUnits(rows, units) {
  const tested = rows.filter(statesATest);
  const findings = [];
  const run = (rules, list) => {
    if (!rules.length || !list.length) return;
    for (const result of check(list, rules).results) {
      for (const finding of result.breaks) findings.push({ rule: finding.rule, where: result.where ?? '', ...(result.line ? { line: result.line } : {}),
        found: finding.found, says: finding.says });
    }
  };
  run(tested.filter(row => !readsValue(row)), units.filter(unit => unit.view === undefined && typeof unit.text === 'string' && unit.text.trim()));
  run(tested.filter(readsValue), units.filter(unit => unit.view !== undefined));
  return findings;
}

// ---- units of a commit, a push and a tool call

function git(root, args) {
  return execFileSync('git', ['-C', root, '-c', 'core.quotePath=false', ...args], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
}

const hasCommit = (root, ref) => spawnSync('git', ['-C', root, 'rev-parse', '--verify', '-q', `${ref}^{commit}`]).status === 0;

/** The added lines of a unified diff, one text unit each, with the file and line they land on. */
export function addedLines(diff, kind) {
  const units = [];
  let file = null, line = 0, header = false;
  for (const text of diff.split('\n')) {
    if (text.startsWith('diff --git ')) { header = true; file = null; continue; }
    if (header && text.startsWith('+++ ')) { file = text === '+++ /dev/null' ? null : text.slice(4).replace(/^b\//, ''); continue; }
    if (text.startsWith('@@')) { header = false; line = Number(/\+(\d+)/.exec(text)?.[1] ?? 0); continue; }
    if (!header && file && text.startsWith('+')) {
      if (text.slice(1).trim()) units.push({ kind, text: text.slice(1), where: file, line });
      line += 1;
    }
  }
  return units;
}

// The whole new value of each JSON file the span changes: a view unit each, or a note when it is not JSON.
function jsonUnits(files, read, kind, notes) {
  const units = [];
  for (const file of files.filter(path => JSON_FILE.test(path))) {
    try {
      units.push({ kind, view: JSON.parse(read(file)), where: file });
    } catch (error) {
      notes.push(fill(W.unreadable_json, { where: file, why: String(error?.message ?? error) }));
    }
  }
  return units;
}

// `git commit -a` / `--all` publishes the tracked files as they stand, not only the index.
const commitsAll = command => /\bcommit\b[^\n;&|]*\s(?:-[A-Za-z]*a[A-Za-z]*|--all)(?=\s|$)/.test(String(command ?? ''));

/** The units a `git commit` would publish: the staged index (or, with -a, the tracked files as they stand). */
export function unitsOfCommit(root, { command = '' } = {}, notes = []) {
  const all = commitsAll(command);
  const base = hasCommit(root, 'HEAD') ? 'HEAD' : EMPTY_TREE;
  const span = all ? [base] : ['--cached', base];
  const diff = git(root, ['diff', '--no-color', '--no-ext-diff', '-M', '-U0', ...span]);
  const files = git(root, ['diff', '--name-only', '-z', '-M', '--diff-filter=AMR', ...span]).split('\0').filter(Boolean);
  const read = file => (all ? readFileSync(join(root, file), 'utf8') : git(root, ['show', `:${file}`]));
  return [...addedLines(diff, 'git-commit'), ...jsonUnits(files, read, 'git-commit', notes)];
}

/** The units a `git push` would publish: the commits from where HEAD left origin/main, as one change. */
export function unitsOfPush(root, notes = []) {
  const found = spawnSync('git', ['-C', root, 'merge-base', 'HEAD', DATA.push_base], { encoding: 'utf8' });
  const base = found.status === 0 ? found.stdout.trim() : EMPTY_TREE;
  if (!hasCommit(root, 'HEAD')) return [];
  const diff = git(root, ['diff', '--no-color', '--no-ext-diff', '-M', '-U0', base, 'HEAD']);
  const files = git(root, ['diff', '--name-only', '-z', '-M', '--diff-filter=AMR', base, 'HEAD']).split('\0').filter(Boolean);
  return [...addedLines(diff, 'git-push'), ...jsonUnits(files, file => git(root, ['show', `HEAD:${file}`]), 'git-push', notes)];
}

/** The units of any other tool call: the call as a view, and each string of its input as text. */
export function unitsOfToolCall(event = {}) {
  const view = { tool_name: String(event.tool_name ?? ''), tool_input: event.tool_input && typeof event.tool_input === 'object' ? event.tool_input : {} };
  return [{ kind: 'tool-call', view, where: view.tool_name },
    ...stringsIn(view.tool_input).filter(one => one.text.trim()).map(one => ({ kind: 'tool-call', text: one.text, where: [view.tool_name, ...one.path].join('.') }))];
}

export function unitsFor(kind, { root, event = {} }, notes = []) {
  if (kind === 'git-commit') return unitsOfCommit(root, { command: event.tool_input?.command }, notes);
  if (kind === 'git-push') return unitsOfPush(root, notes);
  return unitsOfToolCall(event);
}

// ---- fixtures

// A text placed at a path: each named segment a key, each `*` the fixture key, each `**` nothing.
const placedAt = (path, value) => path.split('.').filter(part => part !== '**')
  .reduceRight((inner, part) => ({ [part === '*' ? DATA.fixture_key : part]: inner }), value);

/** The unit one fixture is for one row: a view as given, a text at the row's path for a row that reads a value, else a text. */
export function fixtureUnit(row, fixture) {
  const kind = row.kinds?.[0] ?? DATA.fixture_kind;
  if (fixture && typeof fixture === 'object' && fixture.view !== undefined) return { kind, view: fixture.view };
  const text = typeof fixture === 'string' ? fixture : fixture?.text;
  if (readsValue(row)) return { kind, view: typeof row.path === 'string' ? placedAt(row.path, text) : text };
  return { kind, text };
}

const fixturesOf = row => {
  const given = row[DATA.fixtures_field];
  return { pass: Array.isArray(given?.pass) ? given.pass : [], refuse: Array.isArray(given?.refuse) ? given.refuse : [] };
};

/**
 * Whether one row's fixtures hold: { id, holds, checked, wrong: [{ expected, fixture, got, findings }], no_fixtures?,
 * broken?, read_by_a_model? }. A row read by a model only has holds null; a row with a test and no pass or no refuse
 * fixture, or one judge-words cannot compile, does not hold.
 */
export function fixturesHold(row) {
  if (!statesATest(row)) return { id: row?.id, holds: null, read_by_a_model: true, checked: 0, wrong: [] };
  const { broken } = compiled([row]);
  if (broken.length) return { id: row.id, holds: false, broken: broken[0].why, checked: 0, wrong: [] };
  const { pass, refuse } = fixturesOf(row);
  if (!pass.length || !refuse.length) return { id: row.id, holds: false, no_fixtures: true, checked: 0, wrong: [] };
  const wrong = [];
  for (const [expected, list] of [['pass', pass], ['refuse', refuse]]) {
    for (const fixture of list) {
      const findings = judgeUnits([row], [fixtureUnit(row, fixture)]);
      if ((findings.length > 0) !== (expected === 'refuse')) wrong.push({ expected, fixture, got: findings.length ? 'refused' : 'passed', findings });
    }
  }
  return { id: row.id, holds: !wrong.length, checked: pass.length + refuse.length, wrong };
}

/** The lines that say why a row's fixtures do not hold. */
export function fixtureLines(held) {
  if (held.no_fixtures) return [fill(W.no_fixtures, { rule: held.id })];
  if (held.broken) return [`${fill(W.fixtures_wrong_head, { rule: held.id })} ${held.broken}`];
  return [fill(W.fixtures_wrong_head, { rule: held.id }), ...held.wrong.map(one => fill(W.fixture_wrong, { expected: one.expected,
    fixture: JSON.stringify(one.fixture), got: one.got === 'passed' ? W.fixture_passed : fill(W.fixture_refused, { rules: one.findings.map(f => f.says).join('; ') }) }))];
}

/** Every check row a tool call's input writes (an object of kind `check` carrying fixtures), at any depth, in JSON text too. */
export function checkRowsIn(value) {
  const found = [];
  const walk = node => {
    if (typeof node === 'string') {
      if (node.includes(DATA.fixtures_field) && /^\s*[[{]/.test(node)) { try { walk(JSON.parse(node)); } catch { /* not JSON */ } }
      return;
    }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    if (node.kind === DATA.row_kind && node[DATA.fixtures_field] !== undefined) found.push(node);
    Object.values(node).forEach(walk);
  };
  walk(value);
  return found;
}

// ---- the hook

/**
 * One hook call: { code, said: [lines for the call], refused: [lines] }. Judges the rows kept for this kind on the
 * call's units, says the rows read by a model, marked Off, broken or whose fixtures do not hold, and refuses a call
 * that writes a check row whose fixtures do not hold.
 */
export function judgeACall({ rows = [], event = {}, kind, root }) {
  const said = [], refused = [];
  const kept = rowsFor(rows, kind);
  for (const row of kept.filter(isOff)) said.push(fill(W.off, { rule: row.id }));
  const on = kept.filter(row => !isOff(row));
  for (const row of on.filter(row => !statesATest(row))) said.push(fill(W.read_by_a_model, { rule: row.id, says: row.says ?? '' }));
  const { usable, broken } = compiled(on.filter(statesATest));
  for (const row of broken) said.push(`${fill(W.fixtures_wrong_head, { rule: row.id })} ${row.why}`);
  for (const row of usable) {
    const held = fixturesHold(row);
    if (held.holds === false && !held.no_fixtures) said.push(...fixtureLines(held));
  }
  const notes = [];
  const findings = usable.length ? judgeUnits(usable, unitsFor(kind, { root, event }, notes)) : [];
  said.push(...notes);
  if (findings.length) {
    refused.push(fill(W.refused_head, { kind }), ...findings.map(one => fill(W.refused_finding, { rule: one.rule,
      where: one.where ? `${one.where}${one.line ? `:${one.line}` : ''}: ` : '', found: JSON.stringify(one.found), says: one.says })));
  }
  const written = checkRowsIn(event.tool_input).map(fixturesHold).filter(held => held.holds === false);
  if (written.length) refused.push(W.write_refused_head, ...written.flatMap(fixtureLines));
  return { code: refused.length ? 2 : 0, said, refused };
}

function option(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

if (process.argv[1] && import.meta.url === `file://${realpathSync(process.argv[1])}`) {
  const [mode, ...args] = process.argv.slice(2);
  let input;
  try {
    input = JSON.parse((await readAll(process.stdin)) || '{}');
  } catch (error) {
    input = { error };
  }
  if (mode === 'fixtures') {
    // tool:check-a-check-rows-fixtures: { rows } in, { result: { holds, rows, lines } } out; a row that does not hold is
    // an answer, not an error.
    if (input.error || !Array.isArray(input.rows) || !input.rows.length) {
      console.log(JSON.stringify({ error: W.no_rows }));
      process.exit(1);
    }
    const rows = input.rows.map(fixturesHold);
    const failing = rows.filter(held => held.holds === false);
    console.log(JSON.stringify({ result: { holds: !failing.length, rows, lines: failing.flatMap(fixtureLines) } }));
    process.exit(0);
  }
  if (mode === 'hook') {
    try {
      if (input.error) throw input.error;
      const { code, said, refused } = judgeACall({ rows: Array.isArray(input.rows) ? input.rows : [], event: input.event ?? {},
        kind: option(args, '--kind'), root: option(args, '--root') ?? process.cwd() });
      if (code === 2) process.stderr.write(`${[...refused, ...said].join('\n')}\n`);
      else if (said.length) process.stdout.write(`${JSON.stringify({ systemMessage: said.join('\n') })}\n`);
      process.exit(code);
    } catch (error) {
      process.stderr.write(`judge-check-rows could not judge this call: ${error?.message ?? error}\n`);
      process.exit(1);
    }
  }
  process.stderr.write('usage: judge-check-rows.mjs hook --root <checkout> --kind <kind> < { rows, event }\n'
    + '       judge-check-rows.mjs fixtures < { rows }\n');
  process.exit(1);
}
