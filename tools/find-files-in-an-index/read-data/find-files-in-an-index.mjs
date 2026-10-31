// tools/find-files-in-an-index/read-data/find-files-in-an-index.mjs
//
// Find files in an index that already exists. Reads one JSON request (argv[2]) and prints one JSON line:
// the files whose name, folder path, tags or spoken words match, ranked, with how many candidates each root held.
//
// MOVED, NOT REWRITTEN. The ranking is the retired asset-index `query.mjs` (recall over every row, type gate, name > tag >
// path > text weighting, adjacent-phrase and all-terms boosts, per-root sweep) and the weighted fusion is the retired
// `find.mjs` merge (an earlier command-line query tool). Two things changed: the index location and its field
// names are the request's DATA (they were fixed paths and field names), and the output is one JSON line (it was a list).
//
// An index is a JSON-lines file, one row per file, plus an optional types file. Nothing here names a person, a drive or a
// kind of file; "video" is a word in the types file, not in this code. Read only: it never builds or changes an index.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_FIELDS = { path: 'path', display_path: 'display_path', name: 'name', root: 'root', type: 'content_type', tags: 'tags', text: 'text', identity: 'identity', size: 'size' };
const DEFAULT_WEIGHTS = { name: 5, tag: 4, path: 2, text: 1, phrase: 8, all_terms: 6, book_tag: 10 };
// Fusion weights for extra lanes (meaning, picture) whose hits the caller already has. The words lane weighs 1.
const DEFAULT_LANE_WEIGHTS = { meaning: 1.15, picture: 3, picture_when_type_is_visual: 8 };

function refuse(message) { throw new Error(message); }

export function readIndex({ index_dir, index_file = 'assets.jsonl', types_file = 'content-types.json' }) {
  if (typeof index_dir !== 'string' || !index_dir) refuse('index_dir is required: the folder that holds the index file.');
  const indexPath = join(index_dir, index_file);
  if (!existsSync(indexPath)) refuse(`There is no index file at ${indexPath}. Set index_dir to the folder that holds ${index_file}, or index_file to its name.`);
  const typesPath = join(index_dir, types_file);
  const types = existsSync(typesPath) ? JSON.parse(readFileSync(typesPath, 'utf8')) : {};
  const rows = readFileSync(indexPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { rows, types };
}

export function searchIndex({ rows, types }, request) {
  const f = { ...DEFAULT_FIELDS, ...(request.fields ?? {}) };
  const w = { ...DEFAULT_WEIGHTS, ...(request.weights ?? {}) };
  const limit = Number.isInteger(request.limit) && request.limit > 0 ? request.limit : 20;
  const raw = String(request.query ?? '').toLowerCase().trim();
  if (!raw) refuse('query is required: the words to look for.');
  let wantType = request.type ?? null;
  const stop = new Set(types.stop_words ?? []);
  const typeWord = {};
  for (const [kind, words] of Object.entries(types.type_keywords ?? {})) for (const word of words) typeWord[word] = kind;
  const terms = [];
  for (const token of raw.split(/[^a-z0-9]+/).filter(Boolean)) {
    if (typeWord[token] && !wantType) wantType = typeWord[token];
    if (typeWord[token] || stop.has(token)) continue;
    terms.push(token);
  }
  const bookIntent = wantType === 'book';
  const typeGate = bookIntent ? null : wantType;
  const perRoot = {};
  const scored = [];
  for (const row of rows) {
    if (request.root && row[f.root] !== request.root) continue;
    const name = String(row[f.name] ?? '').toLowerCase();
    const where = String(row[f.display_path] ?? row[f.path] ?? '').toLowerCase();
    const tags = (row[f.tags] ?? []).join(' ').toLowerCase();
    const text = String(row[f.text] ?? '').toLowerCase();
    let score = 0, hitTerms = 0;
    for (const term of terms) {
      let s = 0;
      if (name.includes(term)) s += w.name;
      if (tags.includes(term)) s += w.tag;
      if (where.includes(term)) s += w.path;
      if (text.includes(term)) s += w.text;
      if (s > 0) hitTerms++;
      score += s;
    }
    const normalized = `${name} ${where} ${tags} ${text}`.replace(/[^a-z0-9]+/g, ' ');
    for (let i = 0; i + 1 < terms.length; i++) if (normalized.includes(`${terms[i]} ${terms[i + 1]}`)) score += w.phrase;
    if (terms.length && hitTerms === 0) continue;
    if (terms.length && hitTerms === terms.length) score += w.all_terms;
    if (bookIntent && (row[f.tags] ?? []).includes('book')) score += w.book_tag;
    perRoot[row[f.root]] = (perRoot[row[f.root]] ?? 0) + 1;
    scored.push({ row, score });
  }
  let final = scored;
  if (typeGate) final = scored.filter(item => item.row[f.type] === typeGate); // hard gate: a typed search never returns another type
  if (bookIntent) {
    const notBook = new Set(['video', 'audio', 'image', 'project']);
    const tagged = scored.filter(item => (item.row[f.tags] ?? []).includes('book') && !notBook.has(item.row[f.type]));
    final = tagged.length ? tagged : scored.filter(item => item.row[f.type] === 'doc');
  }
  if (!terms.length && !bookIntent) final = []; // a query of only type words has nothing to rank
  return { terms, wantType, perRoot, final, f, limit };
}

// The retired find.mjs merge: each lane's scores are scaled to its own best, then summed with the lane's weight.
export function fuse(wordsFinal, lanes, f, wantType, laneWeights) {
  const weights = { ...DEFAULT_LANE_WEIGHTS, ...laneWeights };
  const visual = wantType === 'image' || wantType === 'video';
  const key = row => row[f.display_path] ?? row[f.path];
  const merged = new Map();
  const add = (list, weight, slot) => {
    const max = Math.max(1, ...list.map(item => item.score || 0));
    for (const item of list) {
      const entry = merged.get(key(item.row)) ?? { row: item.row, parts: {} };
      entry.parts[slot] = ((item.score || 0) / max) * weight;
      merged.set(key(item.row), entry);
    }
  };
  add(wordsFinal, 1, 'words');
  add(lanes.meaning ?? [], weights.meaning, 'meaning');
  add(lanes.picture ?? [], visual ? weights.picture_when_type_is_visual : weights.picture, 'picture');
  return [...merged.values()]
    .map(entry => ({ row: entry.row, score: Object.values(entry.parts).reduce((a, b) => a + b, 0), found_by: Object.keys(entry.parts) }))
    .sort((a, b) => b.score - a.score);
}

export function findFilesInAnIndex(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) refuse('The request must be an object with index_dir and query.');
  const found = searchIndex(readIndex(request), request);
  const { f, limit } = found;
  const words = found.final.sort((a, b) => b.score - a.score);
  const lanes = request.other_lanes ?? {};
  // other_lanes.meaning / .picture: [{ row, score }] the caller already has from its own embedding or picture index.
  const ranked = lanes.meaning || lanes.picture
    ? fuse(words, lanes, f, found.wantType, request.lane_weights)
    : words.map(item => ({ row: item.row, score: item.score, found_by: ['words'] }));
  const hit = ({ row, score, found_by }) => ({
    path: row[f.path], display_path: row[f.display_path] ?? row[f.path], root: row[f.root], type: row[f.type],
    identity: row[f.identity] ?? null, size: row[f.size] ?? null, score: Math.round(score * 100) / 100, found_by,
  });
  return {
    query: String(request.query), terms: found.terms, intent_type: found.wantType,
    candidates_per_root: found.perRoot, matched: ranked.length, hits: ranked.slice(0, limit).map(hit),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.stdout.write(`${JSON.stringify(findFilesInAnIndex(JSON.parse(process.argv[2] ?? '{}')))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
