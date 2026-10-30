// tools/check-against-a-persons-rules-and-verdicts/do-work/rules-and-verdicts.mjs
//
// Purpose
//   Checks words, or anything else made for a person (a title, a line of a script, a plan as JSON), against that
//   person's own rules and their own verdicts, and says for each thing pass, fail or uncertain, with every finding and
//   why. Three kinds of input decide it, all handed in by the caller as records:
//     - rules: rule rows the judge-words tool runs (tools/judge-words), plus rows that ask a model a yes/no question
//       (`ask`, answered by the caller: this file never calls a model);
//     - verdict_rules: the person's rule document, the rows read from their verdicts (stated rows fail, inferred rows
//       with `at_most: "uncertain"` only hold), with the fold that says when two texts are one text;
//     - stands: where the person stands on things already made (agree, disagree, partly, in their own words), as the
//       read-where-you-stand tool gives them (tools/where-a-person-stands).
//
// Non-negotiable invariants
//   1. This file holds no rule, word list, kind or person. Every predicate runs in judge-words (makeJudge, ruleApplies,
//      valuesAt), every identity comes from where-a-person-stands (artifactRef, foldWith), and every word this file says
//      is DATA in read-data/words.json.
//   2. Nothing passes on silence. A unit no rule applies to is unqualified; a unit nothing of the person's judges (no
//      stand, no row of theirs) is novel, held at review and failed at final; a `required` row that finds nothing holds
//      at review and fails at final; an `ask` row with no calibrated answer never passes a unit.
//   3. The person's exact stand on a thing comes first: disagree fails it, partly holds it at review and fails it at
//      final, agree decides it (and clears the generic rules their DATA names in agree_clears) unless a row is newer
//      than the stand. Similarity decides nothing: a reworded thing gets no verdict from the stand on the original.
//   4. A row whose `because` names stands takes its strength from the newest of them; with all of them taken back it
//      only holds. A `part` row gives a thing the stand the person took on a part of it (a take gets its voice's).
//   5. An `ask` row (or a reading row) with `at_most: "uncertain"` never fails a unit; a reading row is not even asked
//      until its own calibration status is "usable". A row's `held_when` (the same selection as `when`, over the
//      unit's `facts`) names the units on which its finding only holds.
//   6. A model's answer is the caller's: `check` returns the questions it needs ({ id, rule, question, options, fail,
//      text, context? }) and takes answers by question id. With no answer a question is unknown, never a pass.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { makeJudge, ruleApplies, valuesAt } from '../../judge-words/do-work/judge-words.mjs';
import { artifactRef, foldWith } from '../../where-a-person-stands/do-work/artifact-ref.mjs';
import WORDS from '../read-data/words.json' with { type: 'json' };

const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const IDS = WORDS.rule_ids;
const STAGES = ['review', 'final'];

export class CheckRefusal extends Error {}

// A row states a test when judge-words can compile it; a row with only `says` and `ask` is a reading row, answered by a model.
const states = row => ['words', 'pattern', 'exact', 'check', 'path'].some(field => row[field] !== undefined);
const VERDICT_FIELDS = [['rows', doc => Array.isArray(doc.rows)], ['fold', doc => Boolean(doc.fold) && typeof doc.fold === 'object'],
  ['stage.default', doc => STAGES.includes(doc.stage?.default)], ['stance_rule', doc => typeof doc.stance_rule === 'string'],
  ['novel.rule', doc => typeof doc.novel?.rule === 'string'], ['novel.says', doc => typeof doc.novel?.says === 'string'],
  ['agree_clears.rules', doc => Array.isArray(doc.agree_clears?.rules)]];

/** The person's rule document compiled once: the rows judge-words runs, the part rows, the reading rows and the fold. */
export function compileVerdictRules(doc) {
  const missing = VERDICT_FIELDS.filter(([, has]) => !(doc && typeof doc === 'object' && has(doc))).map(([name]) => name);
  if (missing.length) throw new CheckRefusal(fill(WORDS.refused.verdict_rules, { missing: missing.join(', ') }));
  const tests = doc.rows.filter(states), parts = doc.rows.filter(row => row.part), reading = doc.rows.filter(row => row.ask);
  return { doc, tests, parts, reading, byId: new Map(tests.map(row => [row.id, row])), judge: makeJudge(tests), fold: foldWith(doc.fold) };
}

// Whether a row is for a unit: judge-words ruleApplies on the unit as judge-words reads it (its kind, and `when` over its view).
const isFor = (row, unit) => ruleApplies(row, { kind: unit.kind, text: unit.text, ...(unit.view !== undefined ? { value: unit.view } : {}) });

/** The rows of the person's document that are for a unit ({ text, kind, view? }) and state a test or read a part. */
export const rulesFor = (compiled, unit) => [...compiled.tests, ...compiled.parts].filter(row => isFor(row, unit));

/** The text of a unit: its words, or the JSON text of its view. */
const textOf = unit => (unit.view !== undefined ? JSON.stringify(unit.view) : unit.text);

/**
 * The stand that governs one unit: the newest of the person's stands on it, by its kind (or no kind) and identity. An
 * exact stand (on the same text after the fold, or the same view) wins over a stand on a part the unit contains.
 * Stands taken back (stance null) are no stand.
 */
export function governing(stands, unit, compiled) {
  const text = textOf(unit), key = compiled.fold(text);
  const ref = unit.view !== undefined ? artifactRef({ view: unit.view }) : artifactRef({ text }, compiled.fold);
  const named = stands.filter(stand => stand.stance && (stand.kind == null || stand.kind === unit.kind)
    && (stand.text !== undefined || stand.view !== undefined ? stand.artifact === ref
      : typeof stand.contains === 'string' && key.includes(compiled.fold(stand.contains))));
  const exact = named.filter(stand => stand.contains === undefined);
  const pool = exact.length ? exact : named;
  return pool.reduce((best, stand) => (best && (best.at ?? '') > (stand.at ?? '') ? best : stand), null);
}

const quoted = (stand, asOf) => fill(WORDS.quoted, { did: WORDS.stance_did[stand.stance] ?? stand.stance, why: stand.why ?? '', ref: stand.artifact,
  at: stand.at ? fill(WORDS.quoted_at, { at: stand.at }) : '', as_of: asOf ? fill(WORDS.quoted_as_of, { as_of: asOf }) : '' });
const isIdentity = ref => /^1f:/.test(ref);

/** The strength a row takes from the stands its `because` names: null when it names none (the row's own `at_most` stands). */
function basisOf(row, byRef) {
  const refs = (row.because ?? []).filter(isIdentity);
  if (!refs.length) return null;
  const cited = refs.map(ref => byRef.get(ref)).filter(Boolean);
  if (!cited.length) return { gone: true };
  return { newest: cited.reduce((best, stand) => ((best.at ?? '') > (stand.at ?? '') ? best : stand)) };
}

/**
 * The outcome of a row that found something, at a stage, given its basis: an inferred row only holds (a `required` one
 * fails at final); a stated row fails, holds at review when its newest stand is partly, and cannot fail on an agree.
 */
function outcomeOf(row, basis, stage, { required = false } = {}) {
  if (basis?.gone) return 'uncertain';
  if (row.at_most === 'uncertain') return required && stage === 'final' ? 'fail' : 'uncertain';
  if (basis?.newest.stance === 'agree') return 'uncertain';
  if (basis?.newest.stance === 'partly') return stage === 'final' ? 'fail' : 'uncertain';
  return 'fail';
}

// A finding quotes the person's own words from the newest stand its row came from, never a typed copy.
const sayOf = (row, basis, asOf) => (basis?.gone ? `${row.says} ${WORDS.basis_gone}`
  : basis && basis.newest.stance !== 'agree' ? `${row.says} ${quoted(basis.newest, asOf)}` : row.says);

/** A part row: the stand the person took on the thing found at the row's path, read as a thing of the row's part kind. */
function partFindings(row, unit, stands, compiled, stage, asOf) {
  const out = [];
  for (const { value } of valuesAt(unit.view ?? {}, row.part.path).filter(piece => typeof piece.value === 'string')) {
    const stand = governing(stands, { text: value, kind: row.part.kind }, compiled);
    if (stand?.stance === 'agree') continue;
    const outcome = !stand ? (stage === 'final' ? 'fail' : 'uncertain') : stand.stance === 'disagree' ? 'fail' : stage === 'final' ? 'fail' : 'uncertain';
    out.push({ rule: row.id, outcome, found: value, because: stand ? [stand.artifact] : [],
      says: !stand ? `${row.says} ${fill(WORDS.part_unjudged, { kind: row.part.kind, value })}`
        : `${row.says} ${quoted(stand, asOf)}${stand.stance === 'partly' ? ` ${WORDS.partly}` : ''}` });
  }
  return out;
}

/**
 * Findings of one unit ({ text, kind, view? }) from the person's own rules and stands. Returns { decided, findings,
 * reading }: decided is 'pass' when their exact agree decides the thing (the caller clears agree_clears and takes none
 * of the findings), else null; reading is the reading rows to ask a model, none when their exact stand decides it.
 */
export function verdictFindings(unit, { compiled, stands = [], stage = compiled.doc.stage.default, asOf = null }) {
  const findings = [];
  const stand = governing(stands, unit, compiled);
  const exact = stand !== null && stand.contains === undefined;
  const reading = exact ? [] : compiled.reading.filter(row => isFor(row, unit));
  const found = () => stand.text ?? stand.contains ?? textOf(unit);
  if (stand?.stance === 'disagree') return { decided: null, reading, findings: [{ rule: compiled.doc.stance_rule, outcome: 'fail', found: found(), says: quoted(stand, asOf), because: [stand.artifact] }] };
  if (stand?.stance === 'partly') findings.push({ rule: compiled.doc.stance_rule, outcome: stage === 'final' ? 'fail' : 'uncertain', found: found(),
    says: `${quoted(stand, asOf)} ${WORDS.partly}`, because: [stand.artifact] });
  const overrides = row => row.at && stand?.at && row.at > stand.at;
  if (stand?.stance === 'agree' && !rulesFor(compiled, unit).some(overrides)) return { decided: 'pass', findings: [], reading };
  const byRef = new Map(stands.filter(kept => kept.stance).map(kept => [kept.artifact, kept]));
  const item = unit.view !== undefined ? { value: unit.view, kind: unit.kind } : { text: unit.text, kind: unit.kind };
  const reported = new Set();   // one finding a row: the first piece it found
  for (const finding of compiled.judge([item])) {
    const row = compiled.byId.get(finding.rule);
    if (reported.has(row.id)) continue;
    reported.add(row.id);
    if (stand?.stance === 'agree' && !overrides(row)) continue;
    const basis = basisOf(row, byRef), required = finding.test === 'required';
    findings.push({ rule: row.id, outcome: outcomeOf(row, basis, stage, { required }), found: required ? textOf(unit) : String(finding.found),
      says: sayOf(row, basis, asOf), because: row.because });
  }
  if (unit.view !== undefined) for (const row of compiled.parts.filter(row => isFor(row, unit))) {
    if (stand?.stance === 'agree' && !overrides(row)) continue;
    findings.push(...partFindings(row, unit, stands, compiled, stage, asOf));
  }
  // Novel: no stand of theirs governs it and no row of theirs is for it, so nothing of the person's judges it. Generic
  // rules and model rows are not theirs and do not count: held at review, failed at final, never a pass on silence.
  if (!stand && !rulesFor(compiled, unit).length && !reading.length) findings.push({ rule: compiled.doc.novel.rule,
    outcome: stage === 'final' ? 'fail' : 'uncertain', found: textOf(unit), says: compiled.doc.novel.says, because: [] });
  return { decided: null, findings, reading };
}

const sentencesOf = text => text.match(/[^.!?]+(?:[.!?]+["'”)]*|$)/g)?.map(sentence => sentence.trim()).filter(Boolean) ?? [text];

/** The facts of a text unit that a rule's `when` and `held_when` read (any JSON the caller gives, such as where its words came from). */
const factsOf = unit => (unit.facts && typeof unit.facts === 'object' ? unit.facts : {});

const probability = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null);
const bounded = value => probability(value) !== null;

/**
 * Checks units against rules, the person's rule document and their stands. Returns { results, questions }: one result per
 * unit ({ ...unit, verdict, breaks, uncertain, advisory, qualification, applicable_rule_ids }) and every question a model
 * may answer ({ id, rule, question, options, fail, text, context? }); pass `answers` ({ [id]: { option: p } }) to use them.
 */
export function check(units, rules, { answers = {}, stands = [], verdictRules = null, stage, fieldsByKind = {}, asOf = null } = {}) {
  if (!Array.isArray(rules) || !rules.length) throw new CheckRefusal(WORDS.refused.rules);
  if (!Array.isArray(units) || !units.length || units.some(unit => !unit || typeof unit.kind !== 'string'
    || (unit.view === undefined && (typeof unit.text !== 'string' || !unit.text.trim())))) throw new CheckRefusal(WORDS.refused.units);
  if (stage !== undefined && !STAGES.includes(stage)) throw new CheckRefusal(WORDS.refused.stage);
  const judged = rules.filter(rule => !rule.ask), asking = rules.filter(rule => rule.ask);
  const judge = makeJudge(judged), judgedById = new Map(judged.map(rule => [rule.id, rule]));
  const fieldOf = unit => unit.field ?? fieldsByKind[unit.kind] ?? null;
  const itemOf = unit => (unit.view !== undefined ? { kind: unit.kind, value: unit.view, field: fieldOf(unit), path: unit.path ?? [] }
    : { text: unit.text, field: fieldOf(unit), kind: unit.kind, path: unit.path ?? [], value: factsOf(unit) });
  const readingOf = new Map();
  const results = units.map((unit, at) => {
    const item = itemOf(unit);
    const applicableRules = unit.view !== undefined ? [] : rules.filter(rule => ruleApplies(rule, item));   // word rules judge words, never a JSON artifact
    const findings = unit.view !== undefined ? [] : judge([item]);
    // a row's `held_when` names the units on which its finding only holds, read from the unit's facts
    const holds = finding => { const row = judgedById.get(finding.rule); return Boolean(row?.held_when) && ruleApplies({ when: row.held_when }, item); };
    const breaks = findings.filter(finding => !holds(finding)).map(finding => ({ rule: finding.rule, found: finding.found, says: finding.says, ...(finding.suggest ? { suggest: finding.suggest } : {}) }));
    const held = findings.filter(holds).map(finding => ({ rule: finding.rule, found: finding.found, advisory: true,
      says: `${finding.says} ${WORDS.held}`, why: WORDS.held_why }));
    const verdict = verdictRules ? verdictFindings(unit, { compiled: verdictRules, stands, stage, asOf }) : { decided: null, findings: [], reading: [] };
    // A reading row capped at uncertain that its calibration has not qualified holds whatever a model says, so it holds from its
    // DATA and no question is asked; its own calibration.status turning "usable" is what asks the model.
    const asksModel = row => (row.ask.at_most ?? row.at_most) !== 'uncertain' || row.ask.calibration?.status === WORDS.usable;
    readingOf.set(at, verdict.reading.filter(asksModel));
    const unqualified = verdict.reading.filter(row => !asksModel(row)).map(row => ({ rule: row.id, says: row.says, found: textOf(unit), p_fail: null,
      why: fill(WORDS.reading_not_asked, { status: row.ask.calibration?.status ?? WORDS.no_status }), qualified: false }));
    const titled = verdict.findings.map(({ outcome, ...finding }) => ({ outcome, finding }));
    breaks.push(...titled.filter(entry => entry.outcome === 'fail').map(entry => entry.finding));
    const exempt = verdict.decided === 'pass' ? verdictRules.doc.agree_clears.rules : [];
    if (exempt.length) breaks.splice(0, breaks.length, ...breaks.filter(finding => !exempt.includes(finding.rule)));
    const verdictRows = unit.view !== undefined && verdictRules ? rulesFor(verdictRules, unit).map(row => row.id) : [];
    // Findings the caller already has for this unit (a check that reads units in order, such as what the reader knows by now).
    const also = (unit.also_found ?? []).map(({ outcome, ...finding }) => ({ outcome, finding }));
    breaks.push(...also.filter(entry => entry.outcome === 'fail').map(entry => entry.finding));
    const qualified = applicableRules.length > 0 || verdictRows.length > 0;
    return { ...unit, applicable_rule_ids: [...applicableRules.map(rule => rule.id), ...verdictRows],
      qualification: qualified ? 'word-rules-only' : 'unqualified',
      breaks, uncertain: [...held, ...titled.filter(entry => entry.outcome !== 'fail').map(entry => entry.finding),
        ...also.filter(entry => entry.outcome !== 'fail').map(entry => entry.finding), ...unqualified,
        ...(qualified ? [] : [{ rule: IDS.no_applicable_rule, says: WORDS.no_applicable_rule.says, found: textOf(unit), why: WORDS.no_applicable_rule.why }])] };
  });
  // A model row judges the kinds its DATA lists; a JSON artifact carries a value, not words, so no model row reads it as words.
  const questions = [], refs = [];
  results.forEach((result, at) => {
    for (const rule of [...asking.filter(rule => ruleApplies(rule, itemOf(result))), ...readingOf.get(at)]) {
      sentencesOf(textOf(result)).forEach((sentence, index) => {
        questions.push({ id: `${at}:${rule.id}:${index}`, rule: rule.id, question: rule.ask.question, options: rule.ask.options, fail: rule.ask.fail,
          text: sentence, ...(result.context ? { context: result.context } : {}) });
        refs.push({ at, rule, sentence });
      });
    }
  });
  const per = new Map();
  refs.forEach((ref, index) => {
    const key = `${ref.at}\u0000${ref.rule.id}`;
    if (!per.has(key)) per.set(key, { result: results[ref.at], rule: ref.rule, scores: [] });
    per.get(key).scores.push({ sentence: ref.sentence, p: probability(answers[questions[index].id]?.[ref.rule.ask.fail]) });
  });
  for (const { result, rule, scores } of per.values()) {
    const cal = rule.ask.calibration ?? {};
    const known = scores.filter(score => score.p !== null);
    const worst = known.reduce((best, score) => (score.p > (best?.p ?? -1) ? score : best), null);
    const entry = { rule: rule.id, says: rule.says, found: worst?.sentence ?? scores[0].sentence, p_fail: worst?.p ?? null };
    if ((rule.ask.at_most ?? rule.at_most) === 'uncertain') {
      if (cal.status !== WORDS.usable) result.uncertain.push({ ...entry, why: fill(WORDS.ask_unqualified, { status: cal.status ?? WORDS.no_status }), qualified: false });
      else if (known.length < scores.length) result.uncertain.push({ ...entry, why: WORDS.ask_no_answer });
      else if (worst.p >= cal.t_fail) result.uncertain.push({ ...entry, why: fill(WORDS.ask_capped_over, { p: worst.p.toFixed(4), t_fail: cal.t_fail }) });
    } else if (cal.status !== WORDS.usable) result.uncertain.push({ ...entry, why: fill(WORDS.ask_not_usable, { status: cal.status ?? WORDS.no_calibration }), qualified: false });
    else if (![cal.t_pass, cal.t_fail].every(bounded) || cal.t_pass > cal.t_fail) result.uncertain.push({ ...entry, why: WORDS.ask_bad_bounds });
    else if (worst && worst.p >= cal.t_fail) result.breaks.push(entry);
    else if (known.length < scores.length) result.uncertain.push({ ...entry, why: WORDS.ask_no_answer });
    else if (worst.p >= cal.t_pass) result.uncertain.push({ ...entry, why: fill(WORDS.ask_between, { p: worst.p.toFixed(2), t_pass: cal.t_pass, t_fail: cal.t_fail }) });
  }
  for (const result of results) {
    const applicable = result.view !== undefined ? [] : rules.filter(rule => ruleApplies(rule, itemOf(result)));
    if (applicable.length && applicable.every(rule => rule.ask?.at_most === 'uncertain')
        && !result.uncertain.some(finding => finding.rule === IDS.uncertain_only)) {
      result.uncertain.push({ rule: IDS.uncertain_only, says: WORDS.uncertain_only.says, found: textOf(result), why: WORDS.uncertain_only.why });
    }
    if (result.context_requires_review) {
      result.qualification = 'context-unqualified';
      result.uncertain.push(...result.breaks.map(finding => ({ ...finding, why: WORDS.context_review.finding_why })));
      result.breaks = [];
      result.uncertain.push({ rule: IDS.context_review, found: textOf(result), says: WORDS.context_review.says, why: WORDS.context_review.why });
    }
    result.verdict = result.breaks.length ? 'fail' : result.uncertain.length ? 'uncertain' : 'pass';
    // Uncertain only because model rows are not qualified, or because a row only holds on this unit's facts: no rule that
    // may fail this unit found anything, so a delivery stage may take it as advice.
    result.advisory = result.verdict === 'uncertain' && result.uncertain.every(finding => finding.qualified === false || finding.advisory === true);
  }
  return { results, questions };
}

/** The status of a whole check: unqualified, failed, uncertain or passed. */
export const statusOf = results => (results.some(result => result.qualification === 'unqualified') ? 'unqualified'
  : results.some(result => result.verdict === 'fail') ? 'failed' : results.some(result => result.verdict === 'uncertain') ? 'uncertain' : 'passed');

/** The results in plain words: a head line, then each unit that did not pass with each finding. */
export function linesOf(results) {
  const count = verdict => results.filter(result => result.verdict === verdict).length;
  const lines = [fill(WORDS.lines_head, { units: results.length, fail: count('fail'), uncertain: count('uncertain'), pass: count('pass') })];
  for (const result of results.filter(result => result.verdict !== 'pass')) {
    lines.push(fill(WORDS.lines_unit, { verdict: result.verdict.toUpperCase(), kind: result.kind, where: result.where ?? '' }).trimEnd());
    for (const finding of [...result.breaks, ...result.uncertain]) lines.push(fill(WORDS.lines_finding, { rule: finding.rule, found: finding.found,
      p: finding.p_fail != null ? ` P(fail) ${finding.p_fail.toFixed(2)}` : '', says: finding.says ?? '',
      suggest: finding.suggest ? fill(WORDS.lines_suggest, { suggest: finding.suggest }) : '', why: finding.why ? ` (${finding.why})` : '' }));
  }
  return lines;
}

/**
 * The person's stands as labelled examples for the reading rows, for calibrating the model that answers them: every
 * thing of a reading row's kinds whose governing stand is their exact agree is a good example; a stand a row names in
 * `pairs[].rejected` (its identity) is a bad example for that row. Refuses pairs that name no current exact stand.
 */
export function examplesFromStands(compiled, stands) {
  const kinds = new Set(compiled.reading.flatMap(row => row.kinds ?? []));
  const current = stands.filter(stand => stand.stance && kinds.has(stand.kind) && stand.text !== undefined
    && governing(stands, { text: stand.text, kind: stand.kind }, compiled) === stand);
  const badFor = new Map();
  for (const row of compiled.reading) for (const pair of row.pairs ?? []) badFor.set(pair.rejected, [...(badFor.get(pair.rejected) ?? []), row.id]);
  const named = new Set(current.map(stand => stand.artifact));
  const missing = [...badFor.keys()].filter(ref => !named.has(ref));
  if (missing.length) throw new CheckRefusal(fill(WORDS.refused.pairs, { missing: missing.join(', ') }));
  const items = current.filter(stand => stand.stance === 'agree' || badFor.has(stand.artifact)).map(stand => ({ text: stand.text, kind: stand.kind,
    good: stand.stance === 'agree', bad_for: badFor.get(stand.artifact) ?? [], ref: stand.artifact }));
  return { items, rows: compiled.reading.map(row => row.id) };
}
