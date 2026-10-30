// tools/cross-techniques-with-a-goal/do-work/cross.mjs
//
// Purpose
//   Crosses a goal in any medium (a sales page, a lesson, an app's first screens, a pitch) with every technique a
//   person has kept, whatever medium each came from. Three steps, each the right tool for its question:
//     wants   a writer model says what must happen for the goal to succeed, and for each want which properties of the
//             shared property vocabulary must change (it is shown every property with what it means).
//     join    every row whose operates_on holds one of those properties is a candidate, exactly, through its terms;
//             its mechanisms are the candidate reasons, the ones found in the most media first.
//     pick    the writer picks, for each want, the candidate mechanisms that would make it happen for this goal; rows
//             holding a picked mechanism and a wanted property are the techniques, spread over media.
//   Pairs come from the rows' own fields, and the writer adapts every technique and pair to the goal in one line.
//
// Non-negotiable invariants
//   1. No technique, medium, goal or person is named here. Rows and the vocabulary are the caller's DATA; prompts,
//      limits and which fields hold which vocabulary are DATA (technique-conventions.json).
//   2. Closeness in meaning is not used to decide whether a mechanism serves a want: measured on 2026-10-30, wants and
//      the mechanisms that serve them (0.24-0.37) were no closer than wants and ones that do not (0.22-0.38). The join
//      is exact through terms; judgement is the writer's, over candidates the join found.
//   3. A writer's property or mechanism counts only if it is a term (or an alias) of the vocabulary or the candidate
//      list it was shown; anything else is dropped and listed in `unknown`, never guessed.
//   4. A row's medium never raises or lowers it, so a technique from any medium can answer a goal in any other;
//      candidates are ordered by how many media their mechanism spans, then by how many rows hold it.
//   5. Pairs are structural: "prepares" when the first changes a property the second needs (operates_on joined to
//      needs[].property), "covers" when the two serve different wants.
//   6. Every technique and pair gets a line, a constraint that rules it out (`ruled_out`), or, after the writer was
//      asked twice, a place in `unadapted`; an empty line is never passed off as an answer.
//   7. The adapting writer is shown why a technique works (its mechanism's meaning, needs, effects and the want it
//      serves) and its name, never its source description or medium: the reason is borrowed, not the parts.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { writer } from './meaning.mjs';
import { boundFields, findTerm } from './vocabulary.mjs';

const unique = list => [...new Set(list)];

const wantsSchema = {
  type: 'object', additionalProperties: false, required: ['wants'],
  properties: { wants: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['says', 'properties'], properties: { says: { type: 'string' }, properties: { type: 'array', items: { type: 'string' } } } } } },
};
const picksSchema = {
  type: 'object', additionalProperties: false, required: ['picks'],
  properties: { picks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['want', 'mechanisms'], properties: { want: { type: 'integer' }, mechanisms: { type: 'array', items: { type: 'string' } } } } } },
};
const linesSchema = {
  type: 'object', additionalProperties: false, required: ['lines'],
  properties: { lines: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key', 'line', 'ruled_out_by'], properties: { key: { type: 'string' }, line: { type: 'string' }, ruled_out_by: { type: 'string' } } } } },
};

// Candidate mechanisms for one want's properties: rows joined exactly, mechanisms ordered by media spanned, then rows.
export function candidatesFor(properties, rows, { why, changes }, limit) {
  const holding = rows.filter(row => (row[changes.field] ?? []).some(term => properties.includes(term)));
  const byMechanism = new Map();
  for (const row of holding) {
    for (const term of row[why.field] ?? []) {
      const seen = byMechanism.get(term) ?? { term, media: new Set(), rows: 0 };
      seen.media.add(row.from_medium);
      seen.rows += 1;
      byMechanism.set(term, seen);
    }
  }
  return [...byMechanism.values()]
    .sort((a, b) => b.media.size - a.media.size || b.rows - a.rows || a.term.localeCompare(b.term))
    .slice(0, limit)
    .map(({ term, media, rows: count }) => ({ term, media: media.size, rows: count }));
}

// Techniques for picked (want, mechanism) pairs: rows with the mechanism and a wanted property, many media first.
export function techniquesFor(picked, rows, { why, changes }, limits) {
  const chosen = [];
  const used = new Set();
  const groups = picked.map(({ want, mechanism }) => {
    const holding = rows.filter(row => !used.has(row.id) && (row[why.field] ?? []).includes(mechanism)
      && (row[changes.field] ?? []).some(term => want.properties.includes(term)));
    const media = new Set();
    const spread = [...holding.filter(row => !media.has(row.from_medium) && media.add(row.from_medium)), ...holding];
    return { want, mechanism, rows: unique(spread).slice(0, limits.per_mechanism) };
  });
  for (let turn = 0; turn < limits.per_mechanism && chosen.length < limits.techniques; turn += 1) {
    for (const group of groups) {
      const row = group.rows[turn];
      if (!row || used.has(row.id) || chosen.length >= limits.techniques) continue;
      used.add(row.id);
      chosen.push({ row, want: group.want, mechanism: group.mechanism });
    }
  }
  return chosen;
}

// Pairs among chosen techniques: prepares (a change joined to a need), then covers (different wants).
export function pairsOf(chosen, { changes }, tagged, limit) {
  const pairs = [];
  for (const first of chosen) {
    for (const then of chosen) {
      if (first.row.id === then.row.id || first.mechanism === then.mechanism) continue;
      const need = (then.row.needs ?? []).find(item => item[tagged] && (first.row[changes.field] ?? []).includes(item[tagged]));
      if (need) pairs.push({ first: first.row.id, then: then.row.id, how: 'prepares', because: `${first.row.name ?? first.row.id} changes ${need[tagged]}, which ${then.row.name ?? then.row.id} needs: ${need.says}`, rank: 0 });
      else if (first.want.says !== then.want.says && first.row.id < then.row.id) {
        pairs.push({ first: first.row.id, then: then.row.id, how: 'covers', because: `${first.row.name ?? first.row.id} serves "${first.want.says}"; ${then.row.name ?? then.row.id} serves "${then.want.says}"`, rank: 1 });
      }
    }
  }
  const order = new Map(chosen.map((item, index) => [item.row.id, index]));
  pairs.sort((a, b) => a.rank - b.rank || order.get(a.first) + order.get(a.then) - order.get(b.first) - order.get(b.then));
  const count = new Map();
  return pairs.filter(pair => {
    if ((count.get(pair.first) ?? 0) >= 2 || (count.get(pair.then) ?? 0) >= 2) return false;
    count.set(pair.first, (count.get(pair.first) ?? 0) + 1);
    count.set(pair.then, (count.get(pair.then) ?? 0) + 1);
    return true;
  }).slice(0, limit).map(({ rank, ...pair }) => pair);
}

// The whole tool: { goal, constraints?, rows, vocabulary, models } -> the answer output_schema describes.
// `models.write` may be given directly (a test's recorded writer); otherwise models.writing is { url, model, ... }.
export async function crossTechniquesWithAGoal(input, conventions) {
  const { goal, constraints = [], rows, vocabulary: lexicon } = input;
  if (typeof goal !== 'string' || !goal.trim()) throw new Error('goal is the thing to make or improve, in any medium, in plain words (for example "a sales page for a budgeting app").');
  if (!Array.isArray(rows) || !rows.length) throw new Error('rows are the techniques to cross, each with mechanism and operates_on terms (tool:say-why-a-technique-works gives a row those fields).');
  if (!lexicon?.vocabularies) throw new Error('vocabulary is the lexicon the rows\' terms come from.');
  if (!input.models?.write && !input.models?.writing) throw new Error('models.writing is the chat model that works out the wants, picks the mechanisms and adapts them: { url, model }.');
  const write = input.models.write ?? writer(input.models.writing);
  const bound = boundFields(conventions.bound);
  const [why, changes] = bound;
  const { limits } = conventions.cross;
  const unknown = [];
  const known = (vocabulary, term) => {
    const found = findTerm(lexicon.vocabularies[vocabulary], term);
    if (!found) unknown.push({ vocabulary, term });
    return found?.term;
  };

  const properties = lexicon.vocabularies[changes.vocabulary].terms.map(entry => ({ term: entry.term, says: entry.says }));
  const asked = (await write({ name: 'goal_wants', system: conventions.cross.wants_system, user: { goal, constraints, properties }, schema: wantsSchema })).wants.slice(0, limits.wants);
  const wants = asked.map(want => ({ says: want.says, properties: unique(want.properties.map(term => known(changes.vocabulary, term)).filter(Boolean)) }))
    .filter(want => want.properties.length);

  const mechanismSays = term => lexicon.vocabularies[why.vocabulary].terms.find(entry => entry.term === term)?.says ?? '';
  const candidates = wants.map(want => candidatesFor(want.properties, rows, { why, changes }, limits.candidates_per_want));
  const picks = wants.length ? (await write({
    name: 'pick_mechanisms',
    system: conventions.cross.pick_system,
    user: { goal, constraints, wants: wants.map((want, index) => ({ want: index, says: want.says, candidates: candidates[index].map(item => ({ term: item.term, says: mechanismSays(item.term) })) })) },
    schema: picksSchema,
  })).picks : [];
  const picked = picks.flatMap(pick => {
    const want = wants[pick.want];
    if (!want) return [];
    return pick.mechanisms.slice(0, limits.picks_per_want).flatMap(term => {
      const listed = candidates[pick.want].find(item => item.term === term);
      if (!listed) unknown.push({ vocabulary: why.vocabulary, term });
      return listed ? [{ want, mechanism: term }] : [];
    });
  });
  // Round-robin over wants so every want gets techniques before any gets many.
  const byWant = wants.map(want => picked.filter(item => item.want === want));
  const ordered = [];
  for (let turn = 0; byWant.some(list => list[turn]); turn += 1) for (const list of byWant) if (list[turn]) ordered.push(list[turn]);
  const chosen = techniquesFor(ordered, rows, { why, changes }, limits);
  const pairs = pairsOf(chosen, { changes }, conventions.bound.needs_tagged_by, limits.pairs);

  const techniques = chosen.map(({ row, want, mechanism }) => ({
    id: row.id,
    name: row.name ?? row.id,
    from_medium: row.from_medium,
    ...(row.source_url ? { source_url: row.source_url } : {}),
    [why.field]: row[why.field] ?? [],
    [changes.field]: row[changes.field] ?? [],
    serves: { want: want.says, through: mechanism, properties: (row[changes.field] ?? []).filter(term => want.properties.includes(term)) },
  }));
  // Invariant 7: the writer adapts from the why, never the parts: it sees the mechanism, needs and effects, not the
  // source's description or medium, so the line is made for the goal's medium instead of copying the original.
  const describe = technique => {
    const row = rows.find(item => item.id === technique.id);
    return {
      key: technique.id,
      name: technique.name,
      why_it_works: `${technique.serves.through}: ${mechanismSays(technique.serves.through)}`,
      needs: (row.needs ?? []).map(need => need.says),
      produces: row.produces ?? [],
      serves: technique.serves.want,
    };
  };
  const pairKey = pair => `${pair.first} + ${pair.then}`;
  const asks = [
    ...techniques.map(technique => ({ key: technique.id, ask: describe(technique), kind: 'techniques' })),
    ...pairs.map(pair => ({ key: pairKey(pair), ask: { key: pairKey(pair), first: pair.first, then: pair.then, how: pair.how, because: pair.because }, kind: 'pairs' })),
  ];
  const lineOf = new Map();
  const answered = item => item && (item.line.trim() || item.ruled_out_by.trim());
  // Invariant 6: a line the writer left empty without a reason is asked for once more, alone with the others missing.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const missing = asks.filter(item => !answered(lineOf.get(item.key)));
    if (!missing.length) break;
    const { lines: said } = await write({
      name: attempt ? 'adapt_lines_again' : 'adapt_lines',
      system: conventions.cross.adapt_system,
      user: { goal, constraints, techniques: missing.filter(item => item.kind === 'techniques').map(item => item.ask), pairs: missing.filter(item => item.kind === 'pairs').map(item => item.ask) },
      schema: linesSchema,
    });
    for (const item of said) if (answered(item) && !answered(lineOf.get(item.key))) lineOf.set(item.key, item);
  }
  const ruledOut = [];
  const unadapted = [];
  const adapted = (items, keyOf) => items.flatMap(item => {
    const said = lineOf.get(keyOf(item));
    if (said?.ruled_out_by?.trim() && !said.line.trim()) {
      ruledOut.push({ key: keyOf(item), by: said.ruled_out_by.trim() });
      return [];
    }
    if (!said) unadapted.push(keyOf(item));
    return [{ ...item, adaptation: said?.line?.trim() ?? '' }];
  });
  const keptTechniques = adapted(techniques, technique => technique.id);
  const keptIds = new Set(keptTechniques.map(technique => technique.id));
  const keptPairs = adapted(pairs.filter(pair => keptIds.has(pair.first) && keptIds.has(pair.then)), pairKey);
  const nameOf = new Map(keptTechniques.map(technique => [technique.id, technique.name]));
  return {
    goal,
    wants: wants.map(want => ({ says: want.says, properties: want.properties })),
    techniques: keptTechniques,
    pairs: keptPairs,
    ruled_out: ruledOut,
    unadapted,
    unknown,
    lines: [
      ...keptTechniques.map(technique => `${technique.name} (from ${technique.from_medium}; ${technique.serves.through}): ${technique.adaptation}`),
      ...keptPairs.map(pair => `${nameOf.get(pair.first)} + ${nameOf.get(pair.then)} (${pair.how}): ${pair.adaptation}`),
    ],
  };
}
