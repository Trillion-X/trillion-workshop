// tools/check-against-a-persons-rules-and-verdicts/do-work/check-copy.mjs
//
// Purpose
//   Checks every word a person will read, and the whole set of them, and says for each unit pass, fail, held or uncertain.
//   Words come in as text, texts, any JSON, HTML pages, rendered decks, picture readings or ready-made units; they leave as
//   units with their findings, plus the problems with the set as a whole (a required line gone, a row for the wrong audience,
//   a count that is not a published list, an offer listing fewer lines than the others, a picture never read).
//   Run by the Workshop tool `tool:check-copy` (do-work/check-copy-words.mjs). It adds the readers and the whole-set checks
//   to what this folder already does: tools/judge-words runs every rule row, and ./rules-and-verdicts.mjs runs the rows
//   against units, a person's stands and model questions.
//
// Non-negotiable invariants
//   1. No rule, word list, locked line, feature, person or product lives here. Rules, locked lines, the feature inventory,
//      approvals, audiences and counts are all the caller's input at run time. The only rows kept here are mechanical
//      grammar (read-data/copy-grammar-rules.json), used when the caller sends none.
//   2. Nothing passes on silence. A source with no words, a rules list the checker cannot compile, a picture with no reading,
//      a required line absent, a unit no rule applies to: each is a problem, a fail or a hold, never a pass.
//   3. A removal passes only with an approval whose `words` are found literally in the `source_text` sent with it. This file
//      reads no file; the caller reads the file and hands the text.
//   4. A model question is the caller's to answer. This file returns the questions (with `answers` it uses them) and never
//      calls a model.
//   5. Exit codes: 0 passed, 1 a rule failed or the set has a problem, 3 held (a unit is uncertain or unqualified and not advisory).
//
// Input (all optional except that some words must arrive):
//   rules, kind, text, texts, value/fields/skip_keys/paths, units[{ kind, text, where, facts }],
//   sources[{ where, json, skip_keys, kind }], alt_keys, html[{ where, html, kind }], decks[{ where, html }],
//   pictures[{ path, blake3 }] with readings{ <blake3>: { text } }, kind_aliases{ kind: [kinds] }, not_for_kinds{ row id: [kinds] },
//   required{ locked_lines[{ id, alternatives }], entries[{ id, name, lines, port_gap }], baseline_ids[], approvals[{ id, words, source_text }] },
//   audience{ rows[{ id, audience }], allowed[] }, offers{ offers[], list_field, id_field },
//   counts[{ label, document }] with counts_schema, verdict_rules, stands, stage, answers.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { wordsIn } from '../../judge-words/do-work/judge-words.mjs';
import { check, compileVerdictRules, linesOf } from './rules-and-verdicts.mjs';
import { distinctUnits, proseIn, wordsOfDeck, wordsOfHtml } from './read-words.mjs';
import GRAMMAR from '../read-data/copy-grammar-rules.json' with { type: 'json' };
import WORDS from '../read-data/copy-words.json' with { type: 'json' };

const WHOLE = 'whole-text';
const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const fold = text => text.normalize('NFKC').replace(/[‘’‛]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').toLowerCase();

export class CheckCopyRefusal extends Error {}

function gather(input) {
  const found = [];
  const base = input.kind ?? 'copy';
  if (typeof input.text === 'string') found.push({ text: input.text, where: 'text', kind: base });
  (input.texts ?? []).forEach((text, index) => found.push({ text, where: `texts.${index}`, kind: base }));
  if (input.value !== undefined) {
    for (const piece of wordsIn(input.value, { fields: input.fields ?? 'strings', skip_keys: input.skip_keys, paths: input.paths })) {
      found.push({ text: piece.text, where: `value.${piece.path ?? piece.field ?? ''}`, kind: base });
    }
  }
  for (const unit of input.units ?? []) found.push({ ...unit, where: unit.where ?? 'unit' });
  const alt = new Set(input.alt_keys ?? []);
  for (const source of input.sources ?? []) {
    for (const piece of proseIn(source.json, { skip_keys: source.skip_keys })) {
      found.push({ text: piece.text, where: `${source.where}:${piece.path}`, kind: alt.has(piece.path.split('.').pop()) ? 'alt' : (source.kind ?? base) });
    }
  }
  for (const page of input.html ?? []) for (const line of wordsOfHtml(page.html)) found.push({ text: line, where: page.where, kind: page.kind ?? base });
  for (const deck of input.decks ?? []) for (const piece of wordsOfDeck(deck.html, deck.where)) found.push({ ...piece, kind: 'deck' });
  return found;
}

function pictureProblems(input) {
  const problems = [], found = [];
  for (const picture of input.pictures ?? []) {
    const reading = input.readings?.[picture.blake3];
    if (!reading) { problems.push(fill(WORDS.problems.picture_unread, picture)); continue; }
    if (String(reading.text ?? '').trim()) found.push({ text: reading.text, where: `${picture.blake3} (${picture.path})`, kind: 'image-text' });
  }
  return { problems, found };
}

function requiredRows(required = {}) {
  const rows = [], problems = [];
  const present = new Set([...(required.entries ?? []), ...(required.locked_lines ?? [])].map(entry => entry.id));
  const approved = new Set();
  for (const approval of required.approvals ?? []) {
    if (typeof approval.source_text === 'string' && approval.words && fold(approval.source_text).includes(fold(approval.words))) approved.add(approval.id);
    else problems.push(fill(WORDS.problems.approval_unproven, approval));
  }
  const need = (id, kind, name, alternatives, why) => rows.push({ id: `required:${kind}:${id}`, kinds: [WHOLE], words: alternatives.map(fold), required: true,
    says: fill(WORDS.problems.required_missing, { name, why }) });
  for (const line of required.locked_lines ?? []) {
    if (!approved.has(line.id)) need(line.id, 'locked-line', `The locked line "${line.alternatives[0]}"`, line.alternatives, WORDS.required.locked);
  }
  for (const entry of required.entries ?? []) {
    if (!approved.has(entry.id)) need(entry.id, 'feature', `The feature "${entry.name}"`, entry.lines,
      entry.port_gap ? fill(WORDS.required.gap, { gap: entry.port_gap }) : WORDS.required.promised);
  }
  for (const id of required.baseline_ids ?? []) if (!present.has(id) && !approved.has(id)) problems.push(fill(WORDS.problems.baseline_gone, { id }));
  return { rows, problems };
}

function audienceProblems(audience) {
  if (!audience) return [];
  return (audience.rows ?? []).filter(row => !audience.allowed.includes(row.audience))
    .map(row => fill(WORDS.problems.audience, { id: row.id, audience: JSON.stringify(row.audience ?? null), allowed: audience.allowed.join(', ') }));
}

function offerProblems(offers) {
  if (!offers) return [];
  const listed = (offers.offers ?? []).filter(offer => Array.isArray(offer[offers.list_field]) && offer[offers.list_field].length);
  const every = new Set(listed.flatMap(offer => offer[offers.list_field].map(line => line[offers.id_field])));
  return listed.flatMap(offer => {
    const own = new Set(offer[offers.list_field].map(line => line[offers.id_field]));
    const missing = [...every].filter(id => !own.has(id));
    return missing.length ? [fill(WORDS.problems.offer_short, { id: offer.id, own: own.size, every: every.size, missing: missing.join(', ') })] : [];
  });
}

function countProblems(input) {
  const schema = input.counts_schema ?? 'list-view-file/v1';
  return (input.counts ?? []).filter(count => !(count.document?.schema === schema && count.document.source?.view))
    .map(count => fill(WORDS.problems.count_unpublished, { label: count.label, schema }));
}

/** The kinds a row is for: its own kinds expanded through the aliases, minus its not_for kinds; a row naming none is for every kind but the whole-set kind. */
function rowFor(row, kinds, input) {
  const aliases = input.kind_aliases ?? {};
  const own = row.kinds ?? kinds.filter(kind => kind !== WHOLE);
  const expanded = [...new Set(own.flatMap(kind => [kind, ...(aliases[kind] ?? [])]))];
  const without = new Set([...(row.not_for_kinds ?? []), ...(input.not_for_kinds?.[row.id] ?? [])]);
  const { not_for_kinds, ...plain } = row;
  return { ...plain, kinds: expanded.filter(kind => !without.has(kind)) };
}

/** The whole answer: { status, passed, exit, results, questions, problems, lines }. Refuses with CheckCopyRefusal when nothing can be checked. */
export function checkCopy(input = {}) {
  if (input.rules !== undefined && (!Array.isArray(input.rules) || !input.rules.length)) throw new CheckCopyRefusal(WORDS.refused.bad_rules);
  const pictures = pictureProblems(input);
  const found = [...gather(input), ...pictures.found];
  if (!found.length) throw new CheckCopyRefusal(WORDS.refused.no_units);
  const units = distinctUnits(found, { facts: input.facts ?? {} });
  const required = requiredRows(input.required);
  const whole = required.rows.length ? [{ kind: WHOLE, text: fold(units.map(unit => unit.text).join('\n')), where: 'the whole set', facts: input.facts ?? {} }] : [];
  const kinds = [...new Set([...units.map(unit => unit.kind), ...whole.map(unit => unit.kind)])];
  const rules = [...(input.rules ?? GRAMMAR.rules).map(row => rowFor(row, kinds, input)), ...required.rows];
  let outcome;
  try {
    const verdictRules = input.verdict_rules === undefined ? null : compileVerdictRules(input.verdict_rules);
    outcome = check([...units, ...whole], rules, { answers: input.answers ?? {}, stands: input.stands ?? [], verdictRules,
      stage: input.stage, fieldsByKind: input.fields_by_kind ?? {}, asOf: input.stands_as_of ?? null });
  } catch (error) { throw new CheckCopyRefusal(fill(WORDS.refused.no_checker, { why: error.message })); }
  const problems = [...required.problems, ...pictures.problems, ...audienceProblems(input.audience), ...offerProblems(input.offers), ...countProblems(input)];
  const failing = outcome.results.filter(result => result.verdict === 'fail');
  const uncertain = outcome.results.filter(result => result.verdict === 'uncertain');
  const held = uncertain.filter(result => !result.advisory);
  const exit = failing.length || problems.length ? 1 : held.length ? 3 : 0;
  const status = exit === 1 ? 'failed' : exit === 3 ? 'held' : 'passed';
  return { status, passed: exit === 0, exit, units: outcome.results.length, failing: failing.length, held: held.length, advisory: uncertain.length - held.length,
    problems, results: outcome.results, questions: outcome.questions, lines: [...problems, ...linesOf(outcome.results)] };
}
