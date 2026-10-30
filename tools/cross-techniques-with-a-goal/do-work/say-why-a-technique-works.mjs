// tools/cross-techniques-with-a-goal/do-work/say-why-a-technique-works.mjs
//
// Purpose
//   `tool:say-why-a-technique-works`: one JSON request on standard input ({ rows, vocabulary?, reading?, models }), `{ result }`
//   on the last line: each row's crossing fields (mechanism, operates_on, needs, produces, from_medium) with the
//   writer's own proposal kept as `proposed`, the vocabulary after admitting the rows' terms, what was merged into
//   what (`admitted`), and any row not read (`unread`). Uncertain terms are judged by the same writer now. A request
//   without a vocabulary starts one from the measured lines in technique-conventions.json; `reading` names which of
//   the rows' own fields the writer reads first or skips (say-why.mjs forRows).
//
// Non-negotiable invariants
//   1. The returned vocabulary is the caller's to keep: the next request hands it back, so terms are shared across
//      every capture. Nothing is kept between runs here.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { readFileSync } from 'node:fs';
import { embedder, sameMeaning, writer } from './meaning.mjs';
import { askingJudge, forRows, makeProposer, makeSettler } from './say-why.mjs';
import { emptyLexicon } from './vocabulary.mjs';

const shipped = JSON.parse(readFileSync(new URL('./technique-conventions.json', import.meta.url), 'utf8'));

export async function sayWhyATechniqueWorks(request) {
  if (!Array.isArray(request.rows) || !request.rows.length || request.rows.some(row => row?.id === undefined)) {
    throw new Error('rows is a list of technique rows, each with an id and its own words (name, description, ...).');
  }
  const conventions = forRows(shipped, request);
  const embed = request.models.embed ?? embedder(request.models.meaning);
  const write = request.models.write ?? writer(request.models.writing);
  const lines = conventions.vocabulary_lines;
  if (!request.vocabulary && !sameMeaning(lines.meaning, embed.meaning)) {
    throw new Error(`Without a vocabulary, models.meaning must be the one the admission lines were measured with: ${JSON.stringify(lines.meaning)}.`);
  }
  const lexicon = request.vocabulary ?? emptyLexicon(embed.meaning, conventions.vocabularies, { reuse_at: lines.reuse_at, new_below: lines.new_below });
  const proposed = await makeProposer({ lexicon, conventions, write, embed })(request.rows);
  const settled = await makeSettler({ lexicon, conventions, embed, judge: askingJudge(write, conventions) })(
    proposed.proposed.map(({ row, proposed: answer }) => ({ id: String(row.id), proposed: answer })),
  );
  const proposalOf = new Map(proposed.proposed.map(({ row, proposed: answer }) => [String(row.id), answer]));
  return {
    rows: settled.rows.map(row => ({ ...row, proposed: proposalOf.get(row.id) })),
    vocabulary: lexicon,
    admitted: settled.admitted,
    unread: proposed.unread,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(JSON.stringify({ result: await sayWhyATechniqueWorks(JSON.parse(readFileSync(0, 'utf8'))) }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
