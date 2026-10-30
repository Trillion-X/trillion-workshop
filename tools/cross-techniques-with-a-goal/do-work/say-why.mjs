// tools/cross-techniques-with-a-goal/do-work/say-why.mjs
//
// Purpose
//   Gives any technique row the fields that let it cross with every other technique, whatever medium it came from:
//   `mechanism` (why it works, as terms of the shared mechanism vocabulary), `operates_on` (the abstract properties it
//   changes, as terms of the shared property vocabulary), `needs` (preconditions, each tagged with the property it is
//   about), `produces` (its effects) and `from_medium` (where it was found). Two steps:
//     propose  a writer model reads a few rows, shown the nearest existing terms for each so it reuses them, and
//              answers in `answerSchema`. The answer is kept as the row's `proposed` DATA, with the writer's name.
//     settle   a deterministic fold of proposals into the lexicon: every proposed term goes through the vocabulary's
//              admission rule (vocabulary.mjs), every need is tagged with its closest property, and the row gets the
//              settled terms. Any writer may propose (a live model, or answers written elsewhere); settling is code.
//
// Non-negotiable invariants
//   1. The source row is never changed. Which source fields the writer reads, the instructions, the worked examples,
//      and which fields hold which vocabulary are DATA (technique-conventions.json); no term or medium is named here.
//   2. After `settle`, every term on a row is a term of the lexicon: a proposal the admission rule merged is replaced
//      by the term it merged into, and a row holds each term once. A row whose admission waits on a judgment that is
//      not yet made settles nothing and is returned in `waiting`, never half-settled.
//   3. A row the writer did not answer is asked again once on its own; a row still unanswered is returned in `unread`
//      with the reason, never silently dropped.
//   4. Writer calls may overlap (`concurrency`); settling runs one row at a time, in the order given, so the same
//      proposals and judgments always fold into the same lexicon.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { admit, boundFields, findTerm, nearest, termKey, withoutProvisional } from './vocabulary.mjs';
import { sameMeaning } from './meaning.mjs';

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
// Words a person reads: strings, or lists of them; a web address is a pointer, not words, so it is left out.
const isWords = value => typeof value === 'string' && !/^https?:\/\//.test(value.trim());
const wordsOf = value => (Array.isArray(value) ? value.filter(isWords).join(', ') : isWords(value) ? value : '');
const unique = list => [...new Set(list)];

// The words of a source row the writer reads: the `first` fields in order, then every other string field not skipped.
export function rowText(row, reading) {
  const named = [...reading.first, ...Object.keys(row).filter(key => !reading.first.includes(key) && !reading.skip.includes(key))];
  const parts = named.map(key => [key, clip(wordsOf(row[key]).trim(), reading.max_chars)]).filter(([, words]) => words);
  return clip(parts.map(([key, words]) => `${key}: ${words}`).join(' | '), reading.row_max_chars);
}

const termSchema = { type: 'object', additionalProperties: false, required: ['term', 'says'], properties: { term: { type: 'string' }, says: { type: 'string' } } };
const phrases = { type: 'array', items: { type: 'string' } };
export const proposalSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'mechanism', 'operates_on', 'needs', 'produces', 'from_medium'],
  properties: {
    id: { type: 'string' },
    mechanism: { type: 'array', items: termSchema },
    operates_on: { type: 'array', items: termSchema },
    needs: phrases,
    produces: phrases,
    from_medium: { type: 'string' },
  },
};
// The fields a settled row holds besides its id: the proposal's fields, with terms settled and needs tagged.
export const settledFields = () => proposalSchema.required.filter(key => key !== 'id');
export const answerSchema ={ type: 'object', additionalProperties: false, required: ['rows'], properties: { rows: { type: 'array', items: proposalSchema } } };
const judgeSchema = { type: 'object', additionalProperties: false, required: ['term'], properties: { term: { type: 'string' } } };

// A judge that asks a writer model, now: async ({ vocabulary, proposal, candidates }) -> an existing term or ''.
export const askingJudge = (write, conventions) => async ({ proposal, candidates }) => (await write({
  name: 'same_meaning',
  system: conventions.same_meaning.system,
  user: { proposed: { term: proposal.term, says: proposal.says }, existing: candidates },
  schema: judgeSchema,
})).term;

// A judge that reads judgments made earlier ([{ vocabulary, term, chosen, among }]: `among` is the candidate terms the
// judgment was made against). A choice holds while it is still a candidate; "none of them" holds only while every
// current candidate was among those judged, since a term added later may be the same. A proposal with no judgment
// that holds is added to `waiting` with its candidates, so a writer can judge it and the fold can run again.
export function recordedJudge(judgments) {
  const byKey = new Map();
  for (const item of judgments) {
    const key = `${item.vocabulary}\u0000${item.term.toLowerCase()}`;
    byKey.set(key, [...(byKey.get(key) ?? []), item]);
  }
  const waiting = [];
  const judge = async ({ vocabulary, proposal, candidates }) => {
    const judged = byKey.get(`${vocabulary}\u0000${proposal.term.toLowerCase()}`) ?? [];
    const chose = judged.find(item => item.chosen && candidates.some(candidate => candidate.term === item.chosen));
    if (chose) return chose.chosen;
    if (judged.some(item => item.chosen === '' && candidates.every(candidate => item.among.includes(candidate.term)))) return '';
    waiting.push({ vocabulary, term: proposal.term, says: proposal.says, candidates });
    return undefined;
  };
  return { judge, waiting };
}

// Live proposing: rows -> [{ row, proposed }] with the nearest existing terms shown for each row.
export function makeProposer({ lexicon, conventions, write, embed }) {
  const { reading, say_why: guide, bound } = conventions;
  const vocabularies = unique(boundFields(bound).map(item => item.vocabulary));
  const examples = guide.examples.map(example => ({ user: { rows: example.rows }, answer: example.answer }));
  async function ask(rows) {
    const texts = rows.map(row => rowText(row, reading));
    const vectors = await embed.texts(texts, 'query');
    const shown = rows.map((row, index) => ({
      id: String(row.id),
      text: texts[index],
      existing: Object.fromEntries(vocabularies.map(name => [name,
        nearest(lexicon.vocabularies[name], vectors[index], reading.nearest_shown).map(({ entry }) => entry.term)])),
    }));
    const answer = await write({ name: 'technique_why', system: guide.system, examples, user: { rows: shown }, schema: answerSchema });
    const byId = new Map(answer.rows.map(item => [item.id, item]));
    return rows.map(row => ({ row, proposed: byId.get(String(row.id)) }));
  }
  // rows -> { proposed: [{ row, proposed }], unread }. onBatch(proposed) runs as each batch is answered.
  return async function propose(rows, { concurrency = 1, onBatch = () => {} } = {}) {
    const batches = [];
    for (let start = 0; start < rows.length; start += reading.rows_per_call) batches.push(rows.slice(start, start + reading.rows_per_call));
    const result = { proposed: [], unread: [] };
    let next = 0;
    const lane = async () => {
      while (next < batches.length) {
        const batch = batches[next];
        next += 1;
        try {
          const answered = await ask(batch);
          for (const item of answered.filter(entry => !entry.proposed)) {
            const [again] = await ask([item.row]);
            if (again.proposed) item.proposed = again.proposed;
            else result.unread.push({ id: String(item.row.id), why: 'the writer returned no entry for this row, twice' });
          }
          const done = answered.filter(item => item.proposed);
          result.proposed.push(...done);
          await onBatch(done);
        } catch (error) {
          result.unread.push(...batch.map(row => ({ id: String(row.id), why: error.message })));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, lane));
    return result;
  };
}

// Settling: a fold of proposals into the lexicon. Vectors for every proposed term and need are made once per call.
export function makeSettler({ lexicon, conventions, embed, judge }) {
  const { bound } = conventions;
  const fieldsOf = boundFields(bound).map(({ field, vocabulary }) => [field, vocabulary]);
  const tagMin = conventions.needs_tags.tag_min;
  if (!sameMeaning(lexicon.meaning, embed.meaning)) {
    throw new Error(`The vocabulary's vectors were made by ${JSON.stringify(lexicon.meaning)}; this run embeds with ${JSON.stringify(embed.meaning)}. Re-embed the vocabulary or use the same meaning.`);
  }
  const termText = item => item.says || item.term;
  // items: [{ id, proposed }] -> { rows: [{ id, mechanism, operates_on, needs, produces, from_medium }], waiting, admitted }
  return async function settle(items) {
    const raw = items.flatMap(({ id, proposed }) => fieldsOf.flatMap(([field, vocabulary]) => proposed[field]
      .filter(item => item.term.trim())
      .map(item => ({ id, field, vocabulary, term: item.term.trim(), says: item.says.trim(), from: id }))));
    // A writer reusing a term it was shown leaves says empty; the term means what any proposal of it said it means, so
    // a term is never embedded or judged by its bare name when a definition exists anywhere in the fold.
    const definitions = new Map();
    for (const proposal of raw) {
      const key = `${proposal.vocabulary}\u0000${termKey(proposal.term)}`;
      if (proposal.says && !definitions.has(key)) definitions.set(key, proposal.says);
    }
    const proposals = raw.map(proposal => ({ ...proposal, says: proposal.says || definitions.get(`${proposal.vocabulary}\u0000${termKey(proposal.term)}`) || '' }));
    const toEmbed = proposals.filter(proposal => !findTerm(lexicon.vocabularies[proposal.vocabulary], proposal.term));
    const termVectors = toEmbed.length ? await embed.texts(toEmbed.map(termText), 'document', toEmbed.map(proposal => ({ title: proposal.term }))) : [];
    const vectorOf = new Map(toEmbed.map((proposal, index) => [proposal, termVectors[index]]));
    const needs = items.flatMap(({ id, proposed }) => proposed.needs.map(says => says.trim()).filter(Boolean).map(says => ({ id, says })));
    const needVectors = needs.length ? await embed.texts(needs.map(need => need.says), 'document', needs.map(() => ({ title: 'none' }))) : [];

    const rows = [];
    const waiting = [];
    const admitted = [];
    for (const { id, proposed } of items) {
      const mine = proposals.filter(proposal => proposal.id === id);
      const settled = [];
      let held = false;
      for (const proposal of mine) {
        const vocabulary = lexicon.vocabularies[proposal.vocabulary];
        // A term this row's own earlier proposals added has no vector yet: embed it now (rare: two coinages in one row).
        const vector = vectorOf.get(proposal) ?? (findTerm(vocabulary, proposal.term) ? null : (await embed.texts([termText(proposal)], 'document', [{ title: proposal.term }]))[0]);
        const outcome = await admit(vocabulary, proposal, vector, ({ proposal: asked, candidates }) => judge({ vocabulary: proposal.vocabulary, proposal: asked, candidates }));
        // A row touching a provisional term (its own waiting proposal, or another's) is held whole (invariant 2).
        if (outcome.provisional) {
          held = true;
          continue;
        }
        settled.push({ ...outcome, field: proposal.field });
        if (outcome.how !== 'same-words') admitted.push({ ...outcome, vocabulary: proposal.vocabulary, row: id });
      }
      if (held) {
        waiting.push(id);
        continue;
      }
      rows.push({
        id,
        ...Object.fromEntries(fieldsOf.map(([field]) => [field, unique(settled.filter(item => item.field === field).map(item => item.term))])),
        needs: needs.map((need, index) => ({ need, index })).filter(({ need }) => need.id === id),
        produces: proposed.produces.map(effect => effect.trim()).filter(Boolean),
        from_medium: proposed.from_medium.trim(),
      });
    }
    // Needs are tagged once the fold is over, against every kept property, so a need is tagged the same whichever
    // row came first.
    const properties = withoutProvisional(lexicon.vocabularies[bound.needs_tagged_by]);
    for (const row of rows) {
      row.needs = row.needs.map(({ need, index }) => {
        const [closest] = nearest(properties, needVectors[index], 1);
        return { says: need.says, [bound.needs_tagged_by]: closest && closest.closeness >= tagMin ? closest.entry.term : null };
      });
    }
    return { rows, waiting, admitted };
  };
}
