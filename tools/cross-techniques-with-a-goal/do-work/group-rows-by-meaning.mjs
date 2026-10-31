// tools/cross-techniques-with-a-goal/do-work/group-rows-by-meaning.mjs
//
// Purpose
//   Finds the rows, across a whole library of row files, that say the same thing, so each idea is kept once with all
//   its evidence: a principle stated by twelve creators becomes one group of twelve rows, not twelve rows. It uses the
//   vocabulary's own admission rule (vocabulary.mjs `admit`) with each row's words as the proposal, so rows are grouped
//   exactly as terms are: the same words, or closeness in meaning at or above the measured `reuse_at`, are the same
//   idea. Rows in the band between `new_below` and `reuse_at` are not merged; each keeps the band's rows as `related`
//   with their closeness, so the person can see and judge them. One JSON request on standard input, { result } on the
//   last line; progress on standard error. `step` says what to do:
//     pairs   pairs of rows from different sources at every closeness, for a person to label same or different, so the
//             lines can be measured for rows (measure-reuse-line.mjs takes the labelled pairs)
//     group   every row folded into groups in the order its sources are given; the groups file holds each row's group
//
// Non-negotiable invariants
//   1. Source files are only read. A row's words are its `text` fields, joined, as the request names them per source.
//   2. A row's vector is made once: the vectors file keeps each row's vector under its id with the BLAKE3 of its words,
//      so a later run embeds only rows whose words are new or changed. Vectors are never compared across meanings.
//   3. A group's id is the id of its first row in fold order, so sources given first (an earlier registry) lead the
//      groups their ideas join. Folding the same rows in the same order always gives the same groups.
//   4. The lines are DATA: technique-conventions.json `row_lines`, measured for rows with the meaning kept beside
//      them; a request whose meaning is another one is refused, never grouped by lines measured for something else.
//   5. Nothing is merged on a guess: band rows are kept apart and linked as `related`, never joined, because a model
//      judging its own kind of text was measured to agree with whatever it is shown.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cosine, embedder, kept, sameMeaning } from './meaning.mjs';
import { hashOf, rowsOfFile } from './say-why-for-files.mjs';
import { admit } from './vocabulary.mjs';

const json = path => JSON.parse(readFileSync(path, 'utf8'));
const conventions = json(fileURLToPath(new URL('./technique-conventions.json', import.meta.url)));
const save = (path, value) => {
  writeFileSync(`${path}.part`, `${JSON.stringify(value)}\n`);
  renameSync(`${path}.part`, path);
};

// Every row of every source as { id, source, text }, in the order the sources are given.
export function libraryRows(sources) {
  return sources.flatMap(source => rowsOfFile(source.file).map(row => ({
    id: String(row[source.id ?? 'id']),
    source: source.label ?? source.file,
    text: source.text.map(field => row[field]).filter(value => typeof value === 'string' && value.trim()).join(' | '),
  })).filter(row => row.text));
}

// The rows with their vectors: cached ones whose words have not changed, the rest embedded now (then saved).
async function withVectors(rows, request, log) {
  const embed = embedder(request.meaning);
  const cache = request.vectors_file && existsSync(request.vectors_file) ? json(request.vectors_file) : null;
  const stored = cache && sameMeaning(cache.meaning, embed.meaning) ? cache.rows : {};
  const todo = rows.filter(row => stored[row.id]?.hash !== hashOf(row.text));
  log(`${rows.length - todo.length} rows have vectors, ${todo.length} to embed`);
  for (let start = 0; start < todo.length; start += 256) {
    const batch = todo.slice(start, start + 256);
    const vectors = await embed.texts(batch.map(row => row.text), 'document');
    batch.forEach((row, index) => { stored[row.id] = { hash: hashOf(row.text), vector: kept(vectors[index]) }; });
    if (request.vectors_file) save(request.vectors_file, { meaning: embed.meaning, rows: stored });
    log(`embedded ${Math.min(start + 256, todo.length)} of ${todo.length}`);
  }
  return rows.map(row => ({ ...row, vector: stored[row.id].vector }));
}

// Pairs of rows from different sources, `per_band` from each closeness band [low, high), closest first within a band.
export function pairsByBand(rows, bands, perBand) {
  const found = bands.map(() => []);
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      if (rows[i].source === rows[j].source) continue;
      const closeness = cosine(rows[i].vector, rows[j].vector);
      const band = bands.findIndex(([low, high]) => closeness >= low && closeness < high);
      if (band >= 0) found[band].push({ closeness: Math.round(closeness * 1000) / 1000, one: rows[i], other: rows[j] });
    }
  }
  return bands.map(([low, high], index) => ({
    band: [low, high],
    pairs: found[index].sort((a, b) => b.closeness - a.closeness).slice(0, perBand)
      .map(({ closeness, one, other }) => ({ closeness, one: { id: one.id, text: one.text }, other: { id: other.id, text: other.text } })),
  }));
}

// Rows folded into groups by the admission rule: { rows: [{ id, group, how, closeness?, related: [{ id, closeness }] }] }.
export async function groupRows(rows, lines) {
  const vocabulary = { reuse_at: lines.reuse_at, new_below: lines.new_below, terms: [] };
  const headOf = new Map();
  const out = [];
  for (const row of rows) {
    let band = [];
    const judge = async ({ candidates }) => {
      band = candidates;
      return '';
    };
    const admitted = await admit(vocabulary, { term: row.text, says: row.text, from: row.id }, row.vector, judge);
    if (admitted.how === 'new' || admitted.how === 'judged-new') headOf.set(admitted.term, row.id);
    out.push({
      id: row.id,
      group: headOf.get(admitted.term),
      how: admitted.how === 'judged-new' ? 'new' : admitted.how,
      ...(admitted.closeness === undefined ? {} : { closeness: admitted.closeness }),
      related: band.map(candidate => ({ id: headOf.get(candidate.term), closeness: candidate.closeness })),
    });
  }
  return { rows: out };
}

export async function groupRowsByMeaning(request, log = () => {}) {
  const lines = conventions.row_lines;
  if (request.step === 'group' && !sameMeaning(lines.meaning, embedder(request.meaning).meaning)) {
    throw new Error(`The measured row lines are for ${JSON.stringify(lines.meaning)}, not ${JSON.stringify(embedder(request.meaning).meaning)}. Measure lines for this model with pairs and measure-reuse-line.mjs, or use that meaning.`);
  }
  const rows = await withVectors(libraryRows(request.sources), request, log);
  if (request.step === 'pairs') return { bands: pairsByBand(rows, request.bands, request.per_band ?? 5) };
  if (request.step === 'group') {
    const grouped = await groupRows(rows, lines);
    const groups = new Set(grouped.rows.map(row => row.group)).size;
    const document = {
      kind: 'rows-grouped-by-meaning',
      what_this_is: 'Which rows of the sources say the same thing: each row, by its id, with the id of its group (the first row of the group in fold order), how it joined (same-words, same-meaning or new), its closeness to the group, and the rows close to it that were not merged (related). Made by group-rows-by-meaning.mjs; the source rows are unchanged.',
      meaning: embedder(request.meaning).meaning,
      lines: { reuse_at: lines.reuse_at, new_below: lines.new_below },
      sources: request.sources.map(source => source.label ?? source.file),
      made: new Date().toISOString().slice(0, 10),
      rows: Object.fromEntries(grouped.rows.map(({ id, ...row }) => [id, row])),
    };
    if (request.groups_file) save(request.groups_file, document);
    return { rows: rows.length, groups, merged: rows.length - groups, related: grouped.rows.filter(row => row.related.length).length, groups_file: request.groups_file };
  }
  throw new Error(`step must be pairs or group; it was ${JSON.stringify(request.step)}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const request = JSON.parse(readFileSync(0, 'utf8'));
  const result = await groupRowsByMeaning(request, line => process.stderr.write(`${line}\n`));
  console.log(JSON.stringify({ result }));
}
