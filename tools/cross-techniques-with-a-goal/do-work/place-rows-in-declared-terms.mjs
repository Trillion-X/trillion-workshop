// tools/cross-techniques-with-a-goal/do-work/place-rows-in-declared-terms.mjs
//
// Purpose
//   Gives each row one term from a short list the person declares (for example the domains their lists filter on),
//   read from the row's own free words (for example the tags a writer gave it), or `none`. The list never grows: it is
//   the person's, so a row whose words are near none of its terms is `none`, never a new term. Placing uses the
//   vocabulary's own admission order (vocabulary.mjs findTerm and nearest): the same words as a term or an alias are
//   that term; else the declared term closest in meaning, when it is at least the measured `placing_line.at_least` of
//   technique-conventions.json close; else none. One JSON request on standard input, { result } on the last line. `step`:
//     closeness  each distinct word of the rows with its three closest declared terms, closest first, for a person to
//                read and measure the line from
//     place      every row's term, written to `out_file` as { rows: { id: { term, from, how, closeness? } } }
//
// Non-negotiable invariants
//   1. The declared terms and the line are DATA: the terms in the request, or read from the file the person keeps them
//      in (`terms_from`, for example the choices of a list field); the line is technique-conventions.json
//      `placing_line`, beside the meaning it was measured with, and a request's meaning must be that one; no term or
//      line is named here. A term's meaning is its words and its `says`, embedded once per run in the document form; a
//      row's word is embedded the same way (meaning.mjs).
//   2. A row's words are tried in the order the row holds them (its main word first); the first that places gives the
//      row its term, and `from` names that word. A row none of whose words place is `none`.
//   3. Source files are only read; the output names the source rows by id.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { embedder, sameMeaning } from './meaning.mjs';
import { rowsOfFile } from './say-why-for-files.mjs';
import { findTerm, nearest } from './vocabulary.mjs';

const conventions = JSON.parse(readFileSync(new URL('./technique-conventions.json', import.meta.url), 'utf8'));

const wordsOf = (row, fields) => fields.flatMap(field => (Array.isArray(row[field]) ? row[field] : [row[field]]))
  .filter(word => typeof word === 'string' && word.trim()).map(word => word.trim().toLowerCase());

// The value at a path in a JSON document. A path step is a key, an index, or { key: value }: the element of a list
// whose key holds that value (so a list definition's field is found by its id, not by where it sits).
export function valueAt(document, path) {
  return path.reduce((value, step) => {
    if (value === undefined || value === null) return undefined;
    if (typeof step === 'object') {
      const [[key, wanted]] = Object.entries(step);
      return Array.isArray(value) ? value.find(item => item?.[key] === wanted) : undefined;
    }
    return value[step];
  }, document);
}

// The declared terms: given in the request, or read from the person's own file where they are kept
// (`terms_from: { file, path }`), each a word or { term, says?, aliases? }.
export function declaredTerms(request) {
  const listed = request.terms_from ? valueAt(JSON.parse(readFileSync(request.terms_from.file, 'utf8')), request.terms_from.path) : request.terms;
  if (!Array.isArray(listed) || !listed.length) throw new Error('No declared terms: give terms, or terms_from { file, path } that leads to a list of them.');
  return listed.map(entry => (typeof entry === 'string' ? { term: entry, says: '', aliases: [] } : { term: entry.term, says: entry.says ?? '', aliases: entry.aliases ?? [] }));
}

export async function placeRowsInDeclaredTerms(request) {
  const line = conventions.placing_line;
  const embed = embedder(request.meaning);
  if (!sameMeaning(line.meaning, embed.meaning)) {
    throw new Error(`The measured placing line is for ${JSON.stringify(line.meaning)}, not ${JSON.stringify(embed.meaning)}. Measure a line for this model with closeness, or use that meaning.`);
  }
  const declared = declaredTerms(request);
  const termVectors = await embed.texts(declared.map(entry => entry.says || entry.term), 'document', declared.map(entry => ({ title: entry.term })));
  const vocabulary = { terms: declared.map((entry, index) => ({ ...entry, vector: termVectors[index] })) };
  const terms = vocabulary.terms;
  const rows = request.sources.flatMap(source => rowsOfFile(source.file).map(row => ({ id: String(row[source.id ?? 'id']), words: wordsOf(row, source.words) })));
  const distinct = [...new Set(rows.flatMap(row => row.words))].filter(word => !findTerm({ terms }, word));
  const vectors = new Map();
  for (let start = 0; start < distinct.length; start += 256) {
    const batch = distinct.slice(start, start + 256);
    const made = await embed.texts(batch, 'document', batch.map(word => ({ title: word })));
    batch.forEach((word, index) => vectors.set(word, made[index]));
  }
  const ranked = (word, k) => nearest(vocabulary, vectors.get(word), k).map(item => ({ term: item.entry.term, closeness: Math.round(item.closeness * 1000) / 1000 }));

  if (request.step === 'closeness') {
    const counts = new Map();
    for (const row of rows) for (const word of row.words) counts.set(word, (counts.get(word) ?? 0) + 1);
    return { words: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([word, rowsHolding]) => {
      const same = findTerm({ terms }, word);
      return { word, rows: rowsHolding, ...(same ? { same_words: same.term } : { closest: ranked(word, 3) }) };
    }) };
  }

  if (request.step === 'place') {
    const placed = {};
    const counts = {};
    for (const row of rows) {
      let result = { term: 'none' };
      for (const word of row.words) {
        const same = findTerm({ terms }, word);
        if (same) { result = { term: same.term, from: word, how: 'same-words' }; break; }
        const [best] = ranked(word, 1);
        if (best && best.closeness >= line.at_least) { result = { term: best.term, from: word, how: 'closest', closeness: best.closeness }; break; }
      }
      placed[row.id] = result;
      counts[result.term] = (counts[result.term] ?? 0) + 1;
    }
    const document = {
      kind: 'rows-placed-in-declared-terms',
      what_this_is: 'Each source row\'s one term from the declared list, read from its own words (the first word that places), or none. Made by place-rows-in-declared-terms.mjs; the source rows are unchanged.',
      terms: terms.map(entry => entry.term),
      at_least: line.at_least,
      meaning: embed.meaning,
      made: new Date().toISOString().slice(0, 10),
      rows: placed,
    };
    writeFileSync(`${request.out_file}.part`, `${JSON.stringify(document)}\n`);
    renameSync(`${request.out_file}.part`, request.out_file);
    return { rows: rows.length, terms: counts, out_file: request.out_file };
  }
  throw new Error(`step must be closeness or place; it was ${JSON.stringify(request.step)}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify({ result: await placeRowsInDeclaredTerms(JSON.parse(readFileSync(0, 'utf8'))) }));
}
