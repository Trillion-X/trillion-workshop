// tools/cross-techniques-with-a-goal/do-work/say-why-for-files.mjs
//
// Purpose
//   Runs say-why over technique row files on the person's own computer, for a whole library at once. Every row of
//   every source file gets its crossing fields in a NEW sidecar file (`<name>.nxn.json` beside it, or the path the
//   request names), and one lexicon file holds the vocabulary all of them share. One JSON request on standard input,
//   { result } on the last line; progress goes to standard error. `step` says what to do:
//     list     the rows that have no current proposal, as { source, id, text } (the words a writer reads)
//     propose  ask the writer model (models.writing) for those rows' proposals, a few rows per call
//     take     put proposals written elsewhere (files of { proposed_by, rows: [proposal] }) onto their rows
//     settle   fold proposals into the lexicon (say-why.mjs makeSettler) and write each row's settled fields; judge
//              "ask" asks models.writing about uncertain terms now, judge "recorded" reads judgments_file and returns
//              the ones still to judge in `waiting`. `fresh` folds every row again from an empty lexicon.
//
// Non-negotiable invariants
//   1. A source file is only read, never written. Its rows are the file itself when it is a list, else its `rows`.
//   2. A sidecar row carries `from_hash`, the BLAKE3 of the source row's JSON, and `settled_from`, the BLAKE3 of the
//      proposal it was settled from. list/propose only touch rows whose source changed or that have no proposal;
//      settle (unless fresh) only folds rows whose proposal changed since they were settled. Work is O(changed).
//   3. Sidecars and the lexicon are saved whole to a temporary file and renamed, after every proposing batch and at
//      the end of a settle, so a stopped run keeps everything finished before it stopped.
//   4. Each sidecar names how its fields were made (writer per row in `proposed_by`, meaning model, the conventions
//      file, the day). Every path a sidecar holds is relative to the sidecar.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { embedder, sameMeaning, writer } from './meaning.mjs';
import { askingJudge, forRows, makeProposer, makeSettler, proposalSchema, recordedJudge, rowText, settledFields } from './say-why.mjs';
import { emptyLexicon, withoutProvisional } from './vocabulary.mjs';

const conventionsFile = fileURLToPath(new URL('./technique-conventions.json', import.meta.url));
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => {
  writeFileSync(`${path}.part`, `${JSON.stringify(value, null, 1)}\n`);
  renameSync(`${path}.part`, path);
};
// The first 32 hex digits of the BLAKE3 of the value's JSON (the identity without its `1f:`).
export const hashOf = value => makeHashCodeHexFromBytes(new TextEncoder().encode(JSON.stringify(value))).slice('1f:'.length, '1f:'.length + 32);
export const rowsOf = document => {
  const rows = Array.isArray(document) ? document : document.rows;
  if (!Array.isArray(rows)) throw new Error('A source file is a list of rows, or an object whose rows key is one.');
  return rows;
};
export const sidecarOf = file => join(dirname(file), `${basename(file, '.json')}.nxn.json`);

// Every source with its rows, hashes and sidecar (made empty when there is none yet).
function openLibrary(request) {
  return request.sources.map(source => {
    const sidecarFile = source.sidecar ?? sidecarOf(source.file);
    const rows = rowsOf(json(source.file));
    const sidecar = existsSync(sidecarFile) ? json(sidecarFile) : {
      kind: 'technique-crossing-fields',
      what_this_is: 'The crossing fields of every row in the source file, by row id: why it works (mechanism), what it changes (operates_on), what it needs (each need tagged with its property) and produces, and the medium it came from. Terms are from the vocabulary file. `proposed` is the writer\'s own answer, kept as evidence; the source rows are unchanged.',
      of: relative(dirname(sidecarFile), source.file),
      vocabulary: relative(dirname(sidecarFile), request.vocabulary_file),
      rows: [],
    };
    const kept = new Map(sidecar.rows.map(row => [row.id, row]));
    const hashes = new Map(rows.map(row => [String(row.id), hashOf(row)]));
    return { source, sidecarFile, rows, sidecar, kept, hashes };
  });
}

function writeSidecar(entry, meaning) {
  entry.sidecar.method = {
    meaning,
    conventions: relative(dirname(entry.sidecarFile), conventionsFile),
    examples: 'the worked examples in the conventions file were written by Claude; each row\'s writer is its proposed_by',
    made: new Date().toISOString().slice(0, 10),
  };
  entry.sidecar.rows = entry.rows.map(row => entry.kept.get(String(row.id))).filter(Boolean);
  save(entry.sidecarFile, entry.sidecar);
}

const needsProposal = (entry, row) => {
  const kept = entry.kept.get(String(row.id));
  return !kept?.proposed || kept.from_hash !== entry.hashes.get(String(row.id));
};

function openLexicon(request, conventions, meaning, fresh) {
  if (!fresh && existsSync(request.vocabulary_file)) return json(request.vocabulary_file);
  const lines = conventions.vocabulary_lines;
  if (!sameMeaning(lines.meaning, meaning)) {
    throw new Error(`The measured admission lines are for ${JSON.stringify(lines.meaning)}, not ${JSON.stringify(meaning)}. Measure lines for this model with measure-reuse-line.mjs, or use that meaning.`);
  }
  return {
    what_this_is: 'The shared vocabulary technique rows are described in: why a technique works (mechanism) and the properties it changes or needs (property). Terms grow by themselves; a proposed term joins an existing one when it means the same thing (reuse_at and new_below are the measured lines; see the folder README).',
    ...emptyLexicon(meaning, conventions.vocabularies, { reuse_at: lines.reuse_at, new_below: lines.new_below }),
  };
}

const vocabularySizes = lexicon => Object.fromEntries(Object.entries(lexicon.vocabularies).map(([name, vocabulary]) => [name, withoutProvisional(vocabulary).terms.length]));

export async function sayWhyForFiles(request, log = () => {}) {
  const conventions = forRows(json(conventionsFile), request);
  const library = openLibrary(request);

  if (request.step === 'list') {
    return { rows: library.flatMap(entry => entry.rows.filter(row => needsProposal(entry, row))
      .map(row => ({ source: entry.source.file, id: String(row.id), text: rowText(row, conventions.reading) }))) };
  }

  if (request.step === 'rows') {
    return { rows: library.flatMap(entry => entry.rows.flatMap(row => {
      const kept = entry.kept.get(String(row.id));
      if (!kept?.settled_from) return [];
      const carried = Object.fromEntries(conventions.carry.filter(key => row[key] !== undefined).map(key => [key, row[key]]));
      const settled = Object.fromEntries(settledFields().map(key => [key, kept[key]]));
      return [{ id: kept.id, ...carried, ...settled }];
    })) };
  }

  if (request.step === 'take') {
    const byId = new Map(library.flatMap(entry => entry.rows.map(row => [String(row.id), entry])));
    const unknown = [];
    const malformed = [];
    let taken = 0;
    for (const file of request.proposals) {
      const { proposed_by: proposedBy, rows } = json(file);
      if (!proposedBy) throw new Error(`${file} names no proposed_by: say which writer made these proposals.`);
      for (const proposal of rows) {
        const entry = byId.get(proposal.id);
        if (!entry) { unknown.push(proposal.id); continue; }
        const missing = proposalSchema.required.filter(key => proposal[key] === undefined);
        if (missing.length) { malformed.push({ id: proposal.id, missing }); continue; }
        const proposed = Object.fromEntries(proposalSchema.required.filter(key => key !== 'id').map(key => [key, proposal[key]]));
        entry.kept.set(proposal.id, { id: proposal.id, from_hash: entry.hashes.get(proposal.id), proposed_by: proposedBy, proposed });
        taken += 1;
      }
    }
    const meaning = existsSync(request.vocabulary_file) ? json(request.vocabulary_file).meaning : conventions.vocabulary_lines.meaning;
    for (const entry of library) writeSidecar(entry, meaning);
    return { taken, unknown, malformed };
  }

  const embed = embedder(request.models.meaning);

  if (request.step === 'propose') {
    const lexicon = openLexicon(request, conventions, embed.meaning, false);
    const propose = makeProposer({ lexicon, conventions, write: writer(request.models.writing), embed });
    const files = [];
    for (const entry of library) {
      const todo = entry.rows.filter(row => needsProposal(entry, row)).slice(0, request.limit ?? Infinity);
      log(`${basename(entry.source.file)}: ${todo.length} of ${entry.rows.length} rows to propose`);
      const result = await propose(todo, {
        concurrency: request.concurrency ?? 1,
        onBatch: done => {
          for (const { proposed } of done) {
            const { id, ...fields } = proposed;
            entry.kept.set(id, { id, from_hash: entry.hashes.get(id), proposed_by: request.models.writing.model, proposed: fields });
          }
          writeSidecar(entry, embed.meaning);
          log(`${basename(entry.source.file)}: +${done.length} proposed`);
        },
      });
      files.push({ file: entry.source.file, proposed: result.proposed.length, unread: result.unread });
    }
    return { files };
  }

  if (request.step === 'settle') {
    const lexicon = openLexicon(request, conventions, embed.meaning, request.fresh === true);
    const recorded = recordedJudge(request.judgments_file && existsSync(request.judgments_file) ? json(request.judgments_file) : []);
    const judge = request.judge === 'ask' ? askingJudge(writer(request.models.writing), conventions) : recorded.judge;
    const settle = makeSettler({ lexicon, conventions, embed, judge });
    const items = library.flatMap(entry => entry.rows.map(row => entry.kept.get(String(row.id)))
      .filter(kept => kept?.proposed && (request.fresh === true || kept.settled_from !== hashOf(kept.proposed)))
      .map(kept => ({ id: kept.id, proposed: kept.proposed, entry })));
    log(`settling ${items.length} rows${request.fresh === true ? ' from an empty vocabulary' : ''}`);
    const result = await settle(items);
    const entryOf = new Map(items.map(item => [item.id, item.entry]));
    for (const row of result.rows) {
      const entry = entryOf.get(row.id);
      const kept = entry.kept.get(row.id);
      entry.kept.set(row.id, { id: row.id, from_hash: kept.from_hash, proposed_by: kept.proposed_by, ...row, settled_from: hashOf(kept.proposed), proposed: kept.proposed });
    }
    for (const id of result.waiting) {
      const entry = entryOf.get(id);
      const { id: keptId, from_hash: fromHash, proposed_by: proposedBy, proposed } = entry.kept.get(id);
      entry.kept.set(id, { id: keptId, from_hash: fromHash, proposed_by: proposedBy, proposed });
    }
    for (const entry of library) writeSidecar(entry, embed.meaning);
    save(request.vocabulary_file, { ...lexicon, vocabularies: Object.fromEntries(Object.entries(lexicon.vocabularies).map(([name, vocabulary]) => [name, withoutProvisional(vocabulary)])) });
    const waiting = request.judge === 'ask' ? [] : recorded.waiting;
    if (request.waiting_file) save(request.waiting_file, waiting);
    const how = result.admitted.reduce((counts, item) => ({ ...counts, [item.how]: (counts[item.how] ?? 0) + 1 }), {});
    return {
      settled: result.rows.length,
      waiting_rows: result.waiting.length,
      waiting_judgments: waiting.length,
      admitted: how,
      vocabulary: vocabularySizes(lexicon),
      files: library.map(entry => ({ file: entry.source.file, sidecar: entry.sidecarFile, rows: entry.rows.length, settled: entry.sidecar.rows.filter(row => row.settled_from).length })),
    };
  }

  throw new Error(`step must be list, propose, take or settle; it was ${JSON.stringify(request.step)}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const request = JSON.parse(readFileSync(0, 'utf8'));
  const result = await sayWhyForFiles(request, line => process.stderr.write(`${line}\n`));
  console.log(JSON.stringify({ result }));
}
