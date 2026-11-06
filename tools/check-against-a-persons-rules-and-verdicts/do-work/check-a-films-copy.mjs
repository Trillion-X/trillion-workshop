#!/usr/bin/env node
// tools/check-against-a-persons-rules-and-verdicts/do-work/check-a-films-copy.mjs
//
// Purpose
//   tool:check-a-films-copy: a film's copy files (a script table, titles, cards, a post, a description, plain lines,
//   prose, cue narration or an owner's JSON) checked against the person's own branch of their one Checks list. The rules
//   are read at run time through the door by the branch mode (do-work/check-a-branch.mjs rulesOfBranch: the branch's own
//   leaves and every leaf of the branches above it; the nearest branch with judge_settings makes the person's verdict
//   rows), never from a file copy. The film layouts, the spans' settings, the reader profiles, the JSON owners, the field
//   of each kind, the person's origin words and the reader-knowledge rows are their settings row (settings_record, read
//   through tools/settings). It reads the units (do-work/read-film-copy.mjs, do-work/read-words.mjs), marks where each
//   line's words come from (do-work/spans-of-a-plan.mjs, do-work/spoken-origins.mjs), attaches each line's context
//   (do-work/unit-context.mjs build, handed in) and what the reader knows by then (do-work/reader_knowledge.py, handed
//   in), runs the one `check`, and answers the report with its identities (BLAKE3 of every input, the reader settings,
//   the rules and this file) and the exit code of its status. Moved from source-repo-a tools/copy-gate/check.mjs
//   (its command, report, safe source read, reader-knowledge call and decider call) one to one.
//
//   As a tool row: one JSON request on standard input, the records door on descriptor 3, { result } on the last line
//   (do-work/check-against-their-rules-and-verdicts.mjs check-a-films-copy).
//   On the person's computer (its files on disk, the model there):
//   node do-work/check-a-films-copy.mjs <file>... --branch B --settings-record ID (--door-mcp '<argv JSON>' | --door-records F)
//     [--reader film|auto|sectioned-prose|cue-narration|json-words] [--owner ID] [--kind K] [--artifact-kind K] [--stage review|final]
//     [--plan plan.json] [--root DIR] [--context context.json] [--stands stands.json] [--decider live|cache | --no-model]
//     [--decider-python P --decider-layer F] [--reader-knowledge-python P] [--json out] [--report out] [--quiet]
//   exit 0: every line passes; 1: a rule failed; 2: input, reader, rule configuration or applicability is unqualified;
//   3: no fail, but a question or a held row could not establish a pass.
//
// Non-negotiable invariants
//   1. No rule, layout, word list, kind or person is in this file: rules come from the person's branch through the door,
//      layouts and the rest from their settings row, the words this file says from read-data/film-copy.json.
//   2. A source file is read only as a stable regular file within the 8 MiB read budget: a link, a special file or a
//      file that changes while it is read is refused (readSourceBytes).
//   3. Every input file must produce recognized copy with no reader issue, or the whole check is unqualified (exit 2),
//      its report keeping no text of what it could not place.
//   4. This file never calls a model inside the tool: the questions go back to the caller by id, and the computer run
//      hands them to the decider's answer command the computer names (`<python> -I <layer> answer --mode live|cache`, the
//      interface of the copy gate's decider layer, now tools/ask-a-small-model-for-a-verdict: the questions as JSON in,
//      one { option: p } or null each out) and judges with the answers.
//      Without a decider, or with --no-model, every question stays unknown and no line passes on it.
//   5. The reader-knowledge check runs over the reading units in reading order; when it cannot run, every unit holds a
//      finding that says so: a check that did not run never passes a line.
//   6. The lines a model row escalated are listed in the report (`escalated`) for the person's verdict log; this file
//      writes no log and nothing to the person's records.
import { execFileSync } from 'node:child_process';
import { constants, lstatSync, openSync, fstatSync, closeSync, readSync, readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { parseId, RECORD_TYPE, settingsOf } from '../../settings/read-data/settings.mjs';
import { rulesOfBranch } from './check-a-branch.mjs';
import { askedOf, check as checkUnits, CheckRefusal, compileVerdictRules, statusOf } from './rules-and-verdicts.mjs';
import { dedupe, norm, readFile } from './read-film-copy.mjs';
import { wordsOfCueNarration, wordsOfJsonRoles, wordsOfSections } from './read-words.mjs';
import { citedSpans, holding, spansOfPlan } from './spans-of-a-plan.mjs';
import { withSpokenOrigins } from './spoken-origins.mjs';
import FILM from '../read-data/film-copy.json' with { type: 'json' };

const WORDS = FILM.words;
const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const b3 = bytes => makeHashCodeHexFromBytes(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)).slice(3);
const here = dirname(fileURLToPath(import.meta.url));

function readSourceBytes(path) {
  if (constants.O_NOFOLLOW === undefined || constants.O_NONBLOCK === undefined) throw new Error('Safe source open is unavailable.');
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
    && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.size > 8n * 1024n * 1024n) throw new Error('Source must be a regular file within the 8 MiB read budget.');
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !same(opened, before)) throw new Error('Source changed before reading.');
    const buffer = Buffer.alloc(Number(opened.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (!read) break;
      offset += read;
    }
    const bytes = buffer.subarray(0, offset);
    if (!same(opened, fstatSync(descriptor, { bigint: true })) || !same(opened, lstatSync(path, { bigint: true }))
        || BigInt(bytes.length) !== opened.size) throw new Error('Source changed while reading.');
    return bytes;
  } finally { closeSync(descriptor); }
}

/**
 * The person's settings for this tool: their list:settings row (tools/settings), read by its id through the door, or the
 * record already read (as records:read answers it). A missing row, a retired row or a row for another tool is refused.
 */
export async function settingsFor(door, given) {
  let record = given;
  if (typeof given === 'string') {
    parseId(given);
    const value = await door.read(RECORD_TYPE, given);
    if (!value) throw new CheckRefusal(fill(WORDS.no_settings, { id: given }));
    record = { id: given, type: RECORD_TYPE, value };
  }
  if (!record || typeof record !== 'object') throw new CheckRefusal(fill(WORDS.no_settings, { id: JSON.stringify(given) }));
  try { return settingsOf(record, FILM.tool_row); }
  catch (error) { throw new CheckRefusal(error.message); }
}

export { readSourceBytes };

const headingKey = value => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');

/** One profile of the settings, its identity the BLAKE3 of its JSON. */
function readerProfile(settings, id, ownerId = null) {
  if (!FILM.readers.includes(id)) throw new CheckRefusal(fill(WORDS.reader, { readers: FILM.readers.join(', ') }));
  if (id === 'json-words') {
    if (!ownerId) throw new CheckRefusal(fill(WORDS.owner, { owner: '' }));
    const owner = settings.json_owners?.[ownerId];
    if (!owner || typeof owner !== 'object') throw new CheckRefusal(fill(WORDS.no_owner, { owner: ownerId }));
    return { id, ownerId, config: owner, blake3: b3('copy-reader:json-words:v1'), ownerBlake3: b3(JSON.stringify(owner)) };
  }
  if (ownerId) throw new CheckRefusal(fill(WORDS.owner, { owner: ownerId }));
  if (id === 'film' || id === 'auto') {
    if (!settings.readers || typeof settings.readers !== 'object') throw new CheckRefusal(WORDS.no_layouts);
    return { id, config: settings.readers, blake3: b3(JSON.stringify(settings.readers)) };
  }
  const config = settings.profiles?.[id];
  if (!config) throw new CheckRefusal(fill(WORDS.no_profile, { profile: id }));
  return { id, config, blake3: b3(JSON.stringify(config)) };
}

/**
 * The units of one file ({ name, text }) with its coverage, read by the reader the request names, before origins and
 * dedupe. A whole JSON artifact (artifact_kind) is one unit whose rows read values at paths of its view.
 */
export function readFileWithCoverage(file, settings, { kind = null, reader = 'film', owner = null, artifactKind = null } = {}) {
  const path = file.name, sourceText = file.text, bytes = Buffer.from(sourceText, 'utf8');
  if (reader === 'json-words' && kind) throw new CheckRefusal(WORDS.kind_with_owner);
  if (artifactKind) {   // a whole JSON artifact (a plan, a report) is one unit: its rows test values at paths of this view
    const view = JSON.parse(sourceText);
    return { units: [{ text: JSON.stringify(view), kind: artifactKind, view, where: path, also_at: [] }],
      coverage: { path, reader: 'artifact', source_blake3: b3(bytes), recognized_units: 1, issues: [] } };
  }
  const selected = readerProfile(settings, reader, owner);
  let chosen = selected, units, issues = [], excluded = {}, public_body_units = null, extra = {};
  if (reader === 'auto') {
    const sectioned = settings.profiles?.[FILM.auto_profile];
    const sectionNames = new Set((sectioned?.sections ?? []).map(section => section.heading).filter(Boolean).map(headingKey));
    const hasSection = sourceText.split('\n').some(line => {
      const heading = /^##\s+(.+?)\s*#*\s*$/u.exec(line.trim());
      return heading && sectionNames.has(headingKey(heading[1]));
    });
    chosen = hasSection ? readerProfile(settings, FILM.auto_profile) : readerProfile(settings, 'film');
  }
  if (chosen.id === 'sectioned-prose') ({ units, issues, excluded, public_body_units } = wordsOfSections(sourceText, path, chosen.config));
  else if (chosen.id === 'cue-narration') {
    const parsed = wordsOfCueNarration(sourceText, path, chosen.config);
    ({ units, issues } = parsed);
    public_body_units = units.length;
    extra = { frontmatter: parsed.frontmatter, cue_ids: parsed.cue_ids };
  } else if (chosen.id === 'json-words') {
    if (extname(path) !== '.json') throw new CheckRefusal('The json-words reader only accepts JSON input.');
    ({ units, issues } = wordsOfJsonRoles(JSON.parse(sourceText), path, chosen.config));
  } else units = readFile(path, kind, sourceText, chosen.config);
  units = units.map(unit => ({ ...unit, text: norm(unit.text), ...(kind ? { kind } : {}), also_at: [] }));
  return { units, coverage: { path, reader: chosen.id, ...(reader === 'auto' ? { requested_reader: 'auto', selector_blake3: selected.blake3 } : {}),
    source_blake3: b3(bytes), reader_blake3: chosen.blake3,
    ...(selected.ownerId ? { owner_id: selected.ownerId, owner_blake3: selected.ownerBlake3 } : {}),
    recognized_units: units.length, public_body_units, excluded, issues, ...extra } };
}

/** The spans each file's lines may come from: the plan the request names, or the plan its plan line names (its files handed in by name). */
function spansFor(file, settings, { plan = null, sources = {} } = {}) {
  if (!settings.spoken_spans) return [];
  holding({ settings, files: sources });
  try { return plan ? spansOfPlan(plan) : citedSpans(file.text); }
  catch (error) {
    if (error.code === 'ENOENT') throw new CheckRefusal(fill(WORDS.plan_missing, { plan: error.message }));
    throw error;
  }
}

/**
 * The units of every file of the request in reading order, deduplicated, with origins and context, and their coverage.
 * The computer run calls it before the reader-knowledge check, so both read the same units in the same order.
 */
export function filmUnits(input, settings, { fold } = {}) {
  if (!Array.isArray(input.files) || !input.files.length || input.files.some(file => typeof file?.name !== 'string' || typeof file?.text !== 'string')) {
    throw new CheckRefusal(WORDS.no_files);
  }
  const reader = input.reader ?? 'film';
  const read = input.files.map(file => {
    const entry = readFileWithCoverage(file, settings, { kind: input.kind ?? null, reader, owner: input.owner ?? null, artifactKind: input.artifact_kind ?? null });
    if (input.artifact_kind) return entry;
    const spans = spansFor(file, settings, { plan: input.plan ?? null, sources: input.sources ?? {} });
    return { ...entry, units: withSpokenOrigins(entry.units, spans, { fold: fold ?? settings.spoken_spans?.fold ?? {}, ...(settings.origin_words ? { origins: settings.origin_words } : {}) }) };
  });
  const fileCoverage = read.map(entry => ({ ...entry.coverage, issues: entry.coverage.issues ?? [], recognized_units: entry.units.length,
    status: !entry.units.length || (entry.coverage.issues ?? []).length ? 'unqualified' : 'extracted' }));
  const units = dedupe(read.flatMap(entry => entry.units));
  // Film context (do-work/unit-context.mjs build), matched by exact text; a unit with no rebuilt context is judged alone.
  const placed = new Map((input.context ?? []).filter(unit => unit?.context).map(unit => [unit.text, unit.context]));
  for (const unit of units) if (placed.has(unit.text)) unit.context = placed.get(unit.text);
  return { units, fileCoverage, extracted: read.reduce((sum, entry) => sum + entry.units.length, 0) };
}

/** The reading units as reader_knowledge.py reads them: { text, kind, where: their index }, in reading order. */
export const readingUnits = units => units.filter(unit => unit.view === undefined).map((unit, at) => ({ text: unit.text, kind: unit.kind, where: at }));

/**
 * Reader-knowledge findings handed in for `count` reading units (reader_knowledge.py's findings), as each unit's
 * also_found. Without findings (`null`: it could not run), every unit gets an uncertain finding saying so.
 */
export function knowledgeOf(count, findings, why = '') {
  if (!Array.isArray(findings)) {
    return Array.from({ length: count }, () => [{ rule: FILM.reader_knowledge_not_run.rule, outcome: 'uncertain', found: '', says: FILM.reader_knowledge_not_run.says, why }]);
  }
  const per = Array.from({ length: count }, () => []);
  for (const finding of findings) per[finding.line]?.push(
    { rule: `${FILM.reader_knowledge_rule_prefix}${finding.rule}`, outcome: finding.outcome, found: finding.span, says: finding.why, sentence: finding.sentence });
  return per;
}

/**
 * The whole film check: settings, the branch's rules, the units, the check, the report. `input`: { branch,
 * settings_record, files: [{ name, text }], reader?, owner?, kind?, artifact_kind?, plan?, plans?, recordings?: { words,
 * tsv }, context?, reader_knowledge?: { findings } | { not_run }, stands?, stands_as_of?, stage?, answers?, no_model?,
 * questions_after? }. Answers { result } with the report and its exit code; never throws on the person's files, only on a
 * request it cannot read.
 */
export async function checkAFilmsCopy(input, door) {
  if (input.rules !== undefined || input.verdict_rules !== undefined) throw new CheckRefusal('Send a branch: a film check reads its rules from the person\'s branch, never from a copy.');
  const settings = await settingsFor(door, input.settings_record);
  const { rules, verdict_rules, lineage, rows_used, read_by_a_model } = await rulesOfBranch(door, input.branch);
  const verdictRules = verdict_rules === null ? null : compileVerdictRules(verdict_rules);
  const reader = input.reader ?? 'film', owner = input.owner ?? null;
  const noModel = input.no_model === true;
  const selected = (() => { try { return input.artifact_kind ? null : readerProfile(settings, reader, owner); } catch { return null; } })();
  const head = {
    schema: FILM.report_schema,
    reader: { id: reader, source_blake3: selected?.blake3 ?? null },
    ...(owner ? { owner: { id: owner, blake3: selected?.ownerBlake3 ?? null } } : {}),
    checker_blake3: b3(readFileSync(fileURLToPath(import.meta.url))),
    rules: { blake3: b3(JSON.stringify(rules)), count: rules.length, source: `branch ${input.branch} (${lineage.join(' <- ')})` },
    ...(verdictRules ? { verdict_rules: { blake3: b3(JSON.stringify(verdictRules.doc)), count: verdictRules.doc.rows.length, source: `branch ${input.branch}: the rows under the nearest judge_settings of its lineage` } } : {}),
    settings_blake3: b3(JSON.stringify(settings)),
    mode: noModel ? FILM.modes.no_model : FILM.modes.answers,
    branch: input.branch, lineage, rows_used, read_by_a_model,
  };
  const unqualifiedAnswer = (coverage, status = 'unqualified') => ({ ...head, status, coverage, results: [], questions: [], exit_code: FILM.exit_codes[status], lines: [] });
  if (!rules.length) return unqualifiedAnswer({ files: [], extracted_units: 0, unique_units: 0, evaluated_units: 0 }, 'no-applicable-rule');
  let read;
  try { read = filmUnits(input, settings, { fold: verdict_rules?.fold }); }
  catch (error) {
    if (!(error instanceof CheckRefusal) && !(error instanceof SyntaxError)) throw error;
    return { ...unqualifiedAnswer({ files: [], extracted_units: 0, unique_units: 0, evaluated_units: 0 }), lines: [`UNQUALIFIED: ${error.message}`] };
  }
  const { units, fileCoverage, extracted } = read;
  if (fileCoverage.some(file => file.status === 'unqualified')) {
    const summary = fileCoverage.map(file => `${file.path}: ${file.recognized_units} recognized unit(s), ${file.issues.length} issue(s)`);
    return { ...unqualifiedAnswer({ files: fileCoverage, extracted_units: extracted, unique_units: 0, evaluated_units: 0 }), lines: [WORDS.unqualified_files, ...summary] };
  }
  const reading = readingUnits(units);
  const found = settings.reader_knowledge === undefined ? reading.map(() => [])
    : knowledgeOf(reading.length, input.reader_knowledge?.findings ?? null, input.reader_knowledge?.not_run ?? '');
  let next = 0;
  const judged = units.map(unit => (unit.view !== undefined ? unit : { ...unit, also_found: [...(unit.also_found ?? []), ...found[next++]] }));
  const checked = checkUnits(judged, rules, { answers: noModel ? {} : input.answers ?? {}, stands: input.stands ?? [], verdictRules,
    stage: input.stage, fieldsByKind: settings.fields_by_kind ?? {}, asOf: input.stands_as_of ?? null });
  const { results } = checked;
  const status = statusOf(results);
  const escalated = results.flatMap(result => result.uncertain.filter(finding => finding.p_fail !== undefined && finding.p_fail !== null)
    .map(finding => ({ text: result.text, kind: result.kind, where: result.where, verdict: 'escalated', rule: finding.rule, p_fail: finding.p_fail, adapter: finding.adapter ?? null, why: finding.why })));
  return {
    ...head, status, passed: status === 'passed',
    coverage: { files: fileCoverage, extracted_units: extracted, unique_units: units.length, evaluated_units: results.length },
    results, ...askedOf(checked.questions, results, { after: input.questions_after ?? null }), escalated,
    lines: report(results, `branch ${input.branch} (${lineage.join(' <- ')})`).split('\n'),
    exit_code: FILM.exit_codes[status],
  };
}

// ---- The person's computer: their files on disk, their model there (the copy gate's command, moved) -----------------
// The Pythons are the ones this computer reports (DECIDER_PYTHON with DECIDER_LAYER, the decider's answer command, and
// READER_KNOWLEDGE_PYTHON, a Python with spaCy), or the flags that name them.
const decider = { python: process.env.DECIDER_PYTHON ?? '', layer: process.env.DECIDER_LAYER ?? '' };
const readerKnowledge = { python: process.env.READER_KNOWLEDGE_PYTHON || 'python3', tool: join(here, 'reader_knowledge.py') };
let readers = {};   // the person's settings for this run

/**
 * Reader-knowledge findings for units in reading order (reader_knowledge.py: a term used before the text introduces it,
 * a label-colon-command paragraph). Returns one list of findings per unit. If the check cannot run, every unit gets an
 * uncertain finding saying so: a check that did not run never passes a line.
 */
export function readerKnowledgeFindings(units) {
  if (readers.reader_knowledge === undefined) return units.map(() => []);
  const dir = mkdtempSync(join(tmpdir(), 'reader-knowledge-'));
  const input = join(dir, 'units.json'), output = join(dir, 'findings.json'), rules = join(dir, 'rules.json');
  writeFileSync(input, JSON.stringify(units.map((unit, at) => ({ text: unit.text, kind: unit.kind, where: at }))));
  writeFileSync(rules, JSON.stringify(readers.reader_knowledge));
  try {
    execFileSync(readerKnowledge.python, ['-I', readerKnowledge.tool, 'check', input, '--units', '--rules', rules, '--json', output], { stdio: 'ignore' });
  } catch (error) {
    if (![1, 3].includes(error.status) || !existsSync(output)) {
      return units.map(() => [{ rule: 'reader-knowledge-not-run', outcome: 'uncertain', found: '', says: 'The reader-knowledge check could not run, so it has not passed this line.', why: String(error.message).split('\n')[0] }]);
    }
  }
  const per = units.map(() => []);
  for (const finding of JSON.parse(readFileSync(output, 'utf8')).findings) per[finding.line].push(
    { rule: `reader-knowledge/${finding.rule}`, outcome: finding.outcome, found: finding.span, says: finding.why, sentence: finding.sentence });
  return per;
}

/** Answers for `ask` rows: [{ question, options, text }] -> [{ option: p } | null], through the decider's answer command. */
function answer(asks, mode) {
  if (!asks.length) return [];
  if (!decider.python || !existsSync(decider.python)) return asks.map(() => null);
  const out = execFileSync(decider.python, ['-I', decider.layer, 'answer', '--mode', mode], { input: JSON.stringify(asks), encoding: 'utf8', maxBuffer: 64 << 20 });
  return JSON.parse(out);
}

/**
 * The copy gate's check on the computer: the Workshop check (rules-and-verdicts.mjs), its questions answered by the
 * decider through `ask` unless noModel, and what the reader knows by then (`inOrder`, one list a unit) as also_found.
 */
export function check(units, rules, { mode = 'live', ask = answer, noModel = false, stances = [], verdictRules = null, inOrder = null, stage = undefined } = {}) {
  const judged = units.map((unit, at) => ({ ...unit, also_found: [...(unit.also_found ?? []), ...(inOrder?.[at] ?? [])] }));
  const run = answers => checkUnits(judged, rules, { answers, stands: stances, verdictRules, stage, fieldsByKind: readers.fields_by_kind ?? {} });
  const first = run({});
  if (noModel || !first.questions.length) return first.results;
  const given = ask(first.questions.map(({ id, rule, ...asked }) => asked), mode);
  return run(Object.fromEntries(first.questions.map((asked, at) => [asked.id, given?.[at]]).filter(([, one]) => one))).results;
}

function report(results, said) {
  const count = verdict => results.filter(r => r.verdict === verdict).length;
  const lines = [`copy check (Workshop judge-words, the person's rules): ${results.length} lines: ${count('fail')} fail, ${count('uncertain')} uncertain, ${count('pass')} pass`, said];
  for (const r of results.filter(r => r.waived?.length)) lines.push('', `WAIVED by the person [${r.kind}] ${r.where}`, `  "${r.text}"`, ...r.waived.map(f => `  ${f.rule}: the person ruled this exact line good`));
  for (const r of results.filter(r => r.verdict !== 'pass')) {
    lines.push('', `${r.verdict.toUpperCase()} [${r.kind}] ${r.where}${r.also_at.length ? ` (also ${r.also_at.length} more)` : ''}`, `  "${r.text}"`);
    for (const f of [...r.breaks, ...r.uncertain]) lines.push(`  ${f.rule}: "${f.found}"${f.p_fail != null ? ` P(fail) ${f.p_fail.toFixed(2)}` : ''}. ${f.says}${f.suggest ? ` Say ${f.suggest}.` : ''}${f.why ? ` (${f.why})` : ''}`);
  }
  return lines.join('\n');
}

/** The records door of a computer run: the person's door through their MCP client, or a stand-in seeded from a records file. */
async function openDoor({ mcp, records }) {
  if (mcp) {
    const { openStdioRecordsDoor } = await import('../../records-door/read-data/stdio-mcp-door.mjs');
    return openStdioRecordsDoor({ argv: JSON.parse(mcp) });
  }
  const held = JSON.parse(readFileSync(records, 'utf8'));
  const all = Array.isArray(held) ? held : held.records;
  const matches = (record, where) => !where || Object.entries(where).every(([name, value]) => JSON.stringify(record.value?.[name]) === JSON.stringify(value));
  return {
    async read(type, id) { return all.find(record => record.type === type && record.id === id)?.value ?? null; },
    async *list(query) { for (const record of all) if (record.type === query.type && matches(record, query.where)) yield record; },
    write() { throw new Error('a film check writes nothing'); },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const value = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
  const valueFlags = new Set(['--kind', '--branch', '--settings-record', '--door-mcp', '--door-records', '--decider', '--decider-python', '--decider-layer', '--json', '--report', '--reader', '--owner', '--context', '--stage', '--stands', '--artifact-kind', '--plan', '--root', '--reader-knowledge-python']);
  const boolFlags = new Set(['--no-model', '--quiet']);
  const files = [];
  for (let at = 0; at < args.length; at++) {
    if (boolFlags.has(args[at])) continue;
    if (valueFlags.has(args[at])) { at++; continue; }
    if (args[at].startsWith('--')) { console.error(`unknown option: ${args[at]}`); process.exit(2); }
    files.push(args[at]);
  }
  if (!files.length || !value('--branch') || !value('--settings-record') || !(value('--door-mcp') || value('--door-records'))) { console.error('usage: node check-a-films-copy.mjs <file>... --branch B --settings-record ID (--door-mcp \'<argv JSON>\' | --door-records F) [--reader film|auto|sectioned-prose|cue-narration|json-words] [--owner DATA-ID] [--kind K] [--artifact-kind K] [--stage final|review] [--plan plan.json] [--root DIR] [--context context.json] [--stands stands.json] [--decider live|cache] [--decider-python P --decider-layer F] [--no-model] [--reader-knowledge-python P] [--json out] [--report out] [--quiet]'); process.exit(2); }
  const reader = value('--reader') ?? 'film';
  const owner = value('--owner');
  const noModel = args.includes('--no-model');
  if (value('--stage') && !['final', 'review'].includes(value('--stage'))) { console.error('--stage must be final or review.'); process.exit(2); }
  let argumentError = null;
  if (value('--json') && value('--report')) { console.error('Choose one of --json or --report.'); process.exit(2); }
  if (noModel && value('--decider')) { console.error('--no-model cannot be combined with --decider.'); process.exit(2); }
  if (reader === 'json-words' && !owner) argumentError = 'The json-words reader requires --owner DATA-ID.';
  if (reader !== 'json-words' && owner) argumentError = '--owner is only valid with --reader json-words.';
  if (reader === 'json-words' && value('--kind')) argumentError = 'JSON owner kind is selected by DATA; --kind is not allowed.';
  if (value('--decider-python')) decider.python = value('--decider-python');
  if (value('--decider-layer')) decider.layer = value('--decider-layer');
  if (value('--reader-knowledge-python')) readerKnowledge.python = value('--reader-knowledge-python');
  const root = value('--root') ?? process.cwd();
  // The person's own files a piece's plan needs (the plan, the word lists, the moment rows), read by name under the root.
  const sources = new Proxy({}, { get: (_, name) => (typeof name === 'string' && existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8') : undefined) });
  let selectedReader, ruleSet, coverage, verdictRules = null;
  try {
    if (argumentError) throw new Error(argumentError);
    const door = await openDoor({ mcp: value('--door-mcp'), records: value('--door-records') });
    readers = await settingsFor(door, value('--settings-record'));
    const branch = await rulesOfBranch(door, value('--branch'));
    if (branch.verdict_rules) verdictRules = compileVerdictRules(branch.verdict_rules);
    selectedReader = value('--artifact-kind') ? { blake3: null } : readerProfile(readers, reader, owner);
    ruleSet = { rules: branch.rules, said: `rules: branch ${value('--branch')} (${branch.lineage.join(' <- ')}), ${branch.rules.length} rows${verdictRules ? ` + ${verdictRules.doc.rows.length} verdict rows` : ''}` };
    if (!Array.isArray(ruleSet.rules) || ruleSet.rules.length === 0) throw new Error('No applicable copy rules were supplied.');
    coverage = files.map(file => {
      const entry = readFileWithCoverage({ name: file, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readSourceBytes(file)) }, readers,
        { kind: value('--kind'), reader, owner, artifactKind: value('--artifact-kind') });
      if (value('--artifact-kind')) return entry;
      const spans = spansFor({ name: file, text: readFileSync(file, 'utf8') }, readers, { plan: value('--plan'), sources });
      return { ...entry, units: withSpokenOrigins(entry.units, spans, { fold: branch.verdict_rules?.fold ?? readers.spoken_spans?.fold ?? {}, ...(readers.origin_words ? { origins: readers.origin_words } : {}) }) };
    });
  } catch (error) {
    console.error(`UNQUALIFIED: ${error.message}`);
    if (value('--report')) writeFileSync(value('--report'), JSON.stringify({ schema: 'copy-check-report-v1', status: 'unqualified',
      reader: { id: reader, source_blake3: selectedReader?.blake3 ?? null },
      ...(owner ? { owner: { id: owner, blake3: selectedReader?.ownerBlake3 ?? null } } : {}),
      checker_blake3: b3(readFileSync(fileURLToPath(import.meta.url))),
      rules: { blake3: ruleSet?.rules ? b3(Buffer.from(JSON.stringify(ruleSet.rules))) : null, count: ruleSet?.rules?.length ?? null, source: ruleSet?.said ?? null },
      mode: noModel ? 'no-model diagnostic; asking rules retained as unknown' : value('--decider') ?? 'live', files: [], results: [] }, null, 2));
    process.exit(2);
  }
  const fileCoverage = coverage.map((entry, index) => ({
    ...entry.coverage,
    issues: entry.coverage.issues ?? [],
    recognized_units: entry.units.length,
    status: !entry.units.length || (entry.coverage.issues ?? []).length ? 'unqualified' : 'extracted',
  }));
  const unqualified = fileCoverage.some(file => file.status === 'unqualified');
  const units = dedupe(coverage.flatMap(entry => entry.units));
  // Film context (unit-context.mjs build DATA), matched by exact text; a unit with no rebuilt context is judged alone.
  const placed = new Map(value('--context') ? JSON.parse(readFileSync(value('--context'), 'utf8')).units.filter(unit => unit.context).map(unit => [unit.text, unit.context]) : []);
  for (const unit of units) if (placed.has(unit.text)) unit.context = placed.get(unit.text);
  if (unqualified) {
    const summary = fileCoverage.map(file => `${file.path}: ${file.recognized_units} recognized unit(s), ${file.issues.length} issue(s)`);
    console.error(`UNQUALIFIED: every input file must produce recognized copy with no reader issues.\n${summary.join('\n')}`);
    if (value('--report')) writeFileSync(value('--report'), JSON.stringify({ schema: 'copy-check-report-v1', status: 'unqualified',
      reader: { id: reader, source_blake3: selectedReader.blake3 },
      ...(owner ? { owner: { id: owner, blake3: selectedReader.ownerBlake3 } } : {}),
      checker_blake3: b3(readFileSync(fileURLToPath(import.meta.url))),
      rules: { blake3: b3(Buffer.from(JSON.stringify(ruleSet.rules))), count: ruleSet.rules.length, source: ruleSet.said },
      mode: noModel ? 'no-model diagnostic; asking rules retained as unknown' : value('--decider') ?? 'live',
      coverage: { files: fileCoverage, extracted_units: coverage.reduce((sum, entry) => sum + entry.units.length, 0), unique_units: 0, evaluated_units: 0 }, results: [] }, null, 2));
    if (value('--json')) writeFileSync(value('--json'), '[]\n');
    process.exit(2);
  }
  let results;
  try {
    const reading = units.filter(unit => !unit.view), found = reading.length ? readerKnowledgeFindings(reading) : [];
    let next = 0;
    results = check(units, ruleSet.rules, { mode: value('--decider') ?? 'live', noModel, inOrder: units.map(unit => (unit.view ? [] : found[next++])), stage: value('--stage') ?? undefined,
      ...(verdictRules ? { verdictRules, stances: value('--stands') ? JSON.parse(readFileSync(value('--stands'), 'utf8')) : [] } : {}) });
  } catch (error) {
    console.error(`UNQUALIFIED: ${error.message}`);
    process.exit(2);
  }
  const ruleBytes = Buffer.from(JSON.stringify(ruleSet.rules));
  const reportData = {
    schema: 'copy-check-report-v1',
    status: results.some(result => result.qualification === 'unqualified') ? 'unqualified'
      : results.some(result => result.verdict === 'fail') ? 'failed' : results.some(result => result.verdict === 'uncertain') ? 'uncertain' : 'passed',
    reader: { id: reader, source_blake3: selectedReader.blake3 },
    ...(owner ? { owner: { id: owner, blake3: selectedReader.ownerBlake3 } } : {}),
    checker_blake3: b3(readFileSync(fileURLToPath(import.meta.url))),
    rules: { blake3: b3(ruleBytes), count: ruleSet.rules.length, source: ruleSet.said },
    ...(verdictRules ? { verdict_rules: { blake3: b3(Buffer.from(JSON.stringify(verdictRules.doc))), count: verdictRules.doc.rows.length, source: value('--branch') } } : {}),
    settings_blake3: b3(JSON.stringify(readers)),
    mode: noModel ? 'no-model diagnostic; asking rules retained as unknown' : value('--decider') ?? 'live',
    coverage: { files: fileCoverage, extracted_units: coverage.reduce((sum, entry) => sum + entry.units.length, 0),
      unique_units: units.length, evaluated_units: results.length },
    results,
    // The lines a model row escalated, for the person's verdict log (tools/where-a-person-stands); nothing is logged here.
    escalated: results.flatMap(r => r.uncertain.filter(u => u.p_fail !== undefined && u.p_fail !== null).map(u => ({ text: r.text, kind: r.kind, where: r.where, verdict: 'escalated', rule: u.rule, p_fail: u.p_fail, adapter: u.adapter ?? null, why: u.why }))),
  };
  console.log(args.includes('--quiet') ? `copy check: ${results.length} units; ${reportData.status}` : report(results, ruleSet.said));
  if (value('--json')) writeFileSync(value('--json'), JSON.stringify(results, null, 1));
  if (value('--report')) writeFileSync(value('--report'), JSON.stringify(reportData, null, 2));
  process.exit(reportData.status === 'unqualified' ? 2 : reportData.status === 'failed' ? 1 : reportData.status === 'uncertain' ? 3 : 0);
}
