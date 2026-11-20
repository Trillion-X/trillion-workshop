// tools/search-everything-with-one-question/do-work/search-everything.mjs
//
// Purpose: the one search over everything the account keeps. This is old trillion's `search` tool (Trillion-X/trillion
// src/file-tools.mjs:125 -> GET /namespace/search, src/namespace.mjs:2127), finished by src/search.mjs:1750 `finish`:
// every lane asked with the same question, a lane that cannot answer named `unavailable` with its reason, each lane
// ranked on its own, and the lanes merged by reciprocal rank fusion into one list of things, best first, each with its
// address. Moved here byte for byte (ports/search-everything.json: lines 1750-1798 and 1893-1917 of src/search.mjs at
// b6ae0ebf), then adapted. trillion-rust had ported the same thing into the engine (src/native_boot/mcp_local.rs
// search_everything_at and src/record_value/search.rs merged); those are deleted in the same move, since the engine
// keeps only the storage reads this calls (engine-feature-boundary.json, Avery 2026-10-29).
//
// What was adapted, and why:
// - The lanes are the records and the file names the caller hands in (`records`, `files`): the caller reads them from the
//   person's own store, in its own language, and this run only searches them. Records of each kind are their own lane (rank
//   1), and the file names are a lane at rank 0.8, asked only when no `type` narrows the question. The index lanes read the
//   semantic-index-descriptor records and the vector set files handed in the same way (meaning/).
// - The index lanes, partial answers, hidden files, canonical file identities, candidate fusion sessions and learned
//   weights read the old Worker's SQL; the Workshop has none of them, so `given` starts empty, nothing is hidden, a file
//   is its own canonical identity and every weight is 1.
// - A lane that was not handed its input (no `records` or no `files`) is named `unavailable`, never guessed. The run reaches
//   no store. A picture index's query vector is handed in (`query_vectors`), made by the encoder read-data/settings.json
//   names for that model; without it, a run whose host lets it run another tool (`host.run`, an ability of the host, not
//   a records operation) asks that encoder, and a run that cannot names the encoder in `unavailable`.
// - A result is its owner's hit (with its address) plus found_in, places, moments, said and the fused score.
import settings from '../read-data/settings.json' with { type: 'json' };
import { searchIndexPlaces } from '../meaning/read-data/meaning-search.mjs';

const config = settings;
const INDEX_MATCHES = new Set();
const answers = null;
const words = value => String(value ?? '').toLocaleLowerCase().replace(/['’]/g, '').match(/[\p{L}\p{N}]+/gu) ?? [];
const round = (value, places = 3) => Math.round(value * 10 ** places) / 10 ** places;
const placeLabel = Object.fromEntries(config.places.map(place => [place.id, place.label]));
const reasonOf = error => error?.code ?? 'refused';
const canonicalFiles = identities => new Map(identities.map(identity => [identity, identity]));
// The lanes a question asks: the records always, the files only when no record type narrows it; and, as old planned
// (src/search.mjs:1518) did for GET /work/api/search, only the asked places, sources and matches when they are named.
const planned = (type, { places = null, sources = null, matches = null } = {}) => config.lanes.filter(lane => (type === undefined || type === null || lane.match === 'records')
  && (!places || lane.place == null || places.includes(lane.place)) && (!sources || sources.includes(lane.source)) && (!matches || matches.includes(lane.match)));

// The person's records and files as this run was handed them: the values the caller read from its own store. `recordsOf`
// lists the records of one kind (all kinds when none is named); `readSpan` reads a bounded span of one of the given files.
// `run` is another Workshop tool's run, when the host gives the run that ability.
function givenOf(fields, host) {
  const records = Array.isArray(fields.records) ? fields.records.filter(record => record && typeof record === 'object') : [];
  const bytesOf = held => Buffer.from(typeof held === 'string' ? held : held?.base64 ?? '', typeof held === 'string' ? 'utf8' : 'base64');
  const files = new Map(Object.entries(fields.files && typeof fields.files === 'object' ? fields.files : {}).map(([name, held]) => [name, bytesOf(held)]));
  return {
    recordsOf: type => (type === undefined ? records : records.filter(record => record.type === type)),
    fileNames: () => [...files.keys()],
    readSpan(name, offset, length) {
      const bytes = files.get(name);
      if (!bytes) throw Object.assign(new Error(`No file named ${name} was handed in.`), { code: 'not_found' });
      const part = bytes.subarray(offset, offset + Math.max(0, length));
      return { byte_length: bytes.length, offset, bytes_returned: part.length, encoding: 'base64', content: part.toString('base64') };
    },
    run: typeof host?.run === 'function' ? (tool, asked) => host.run(tool, asked) : undefined,
  };
}

// The text of a record's values, as words: every word of its JSON, lower case, apostrophes dropped.
const textOf = value => JSON.stringify(value ?? {});

// The records that hold every asked word (a word of the record starts with each term), best first by how many of their
// words are asked for, each with the text it was found in (said) and its address: the record's id and kind, all the caller
// needs to open it in the person's own store.
function searchRecords(given, { question, type, limit }) {
  const terms = [...new Set(words(question).filter(word => word.length >= config.min_word_length))];
  if (!terms.length) return [];
  const hits = [];
  for (const record of given.recordsOf(type)) {
    const recordWords = words(textOf(record.value));
    const matched = recordWords.filter(word => terms.some(term => word.startsWith(term)));
    if (!terms.every(term => recordWords.some(word => word.startsWith(term)))) continue;
    const said = leavesOf(record.value).find(text => terms.some(term => words(text).some(word => word.startsWith(term))));
    hits.push({ id: `record:${record.id}`, record: record.id, type: record.type, found_in: ['written'], said: said ? said.slice(0, 200) : null,
      score: matched.length / Math.max(1, recordWords.length), address: { id: record.id, type: record.type } });
  }
  return hits.sort((a, b) => b.score - a.score || (a.record < b.record ? -1 : a.record > b.record ? 1 : 0)).slice(0, Number.isInteger(limit) ? limit : config.limit);
}

// The strings inside a value, depth first.
function leavesOf(value) {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(leavesOf);
  return [];
}

// The file names that hold every asked word (a word of the file's own name starts with each term), best first, each
// addressed by the path it was handed in under.
function searchFileNames(given, { question, limit }) {
  const terms = [...new Set(words(question).filter(word => word.length >= config.min_word_length))];
  if (!terms.length) return [];
  return given.fileNames().filter(path => { const nameWords = words(path.split('/').at(-1)); return terms.every(term => nameWords.some(word => word.startsWith(term))); })
    .sort().slice(0, Number.isInteger(limit) ? limit : config.limit).map((path, at) => ({ id: `file:${path}`, source: 'files', name: path.split('/').at(-1), path,
      identity: path, found_in: ['name'], said: null, score: 1 / (61 + at), address: { path } }));
}

// `{ question, type?, limit?, records?, files? }` in; `{ question, terms, results, unavailable, pending, sat_out }` out.
// The Workshop tools handed in (`tools`: [{id, title, job, kit}], read by the caller from the Workshop's tool rows and kits): each tool
// scored by how many of the asked words start a word of its title, job or kit text. No all-words rule: a tool that holds some of the
// job's words is a hit, and the most words held ranks first. Answers `find_tool_for_job` (tools/list-and-run-my-tools-for-any-ai).
function searchTools(tools, { question, limit }) {
  const terms = [...new Set(words(question).filter(word => word.length >= config.min_word_length))];
  if (!terms.length || !Array.isArray(tools)) return [];
  const hits = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object' || typeof tool.id !== 'string') continue;
    const toolWords = words([tool.title, tool.job, tool.kit].filter(text => typeof text === 'string').join(' '));
    const matched = terms.filter(term => toolWords.some(word => word.startsWith(term)));
    if (!matched.length) continue;
    hits.push({ id: tool.id, type: 'tool', found_in: ['written'], said: typeof tool.job === 'string' ? tool.job.slice(0, 200) : null,
      score: matched.length / terms.length, address: { id: tool.id, type: 'tool' } });
  }
  return hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, Number.isInteger(limit) ? limit : config.limit);
}

// `records` are the person's records the caller read from its own store ({ id, type, value }); `files` maps each of the
// person's file names to its text or { base64 }. This run reads no store: what is not handed in is not there, and a lane
// that was not handed its input is named `unavailable`. `query_vectors` are the picture queries the caller made with the
// encoders read-data/settings.json names ({ model_id, model_version, vector_base64 }). The host's `run`, when there is
// one, is used for one thing only: another Workshop tool's run, to make a picture query no vector was handed in for.
export async function searchEverything(input, host = {}) {
  const fields = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const given = givenOf(fields, host);
  const indexes = searchIndexPlaces(given, config, fields);
  const mechanisms = {
    indexes: (lane, context) => indexes(lane, context, Number.isInteger(fields.limit) ? fields.limit : config.limit),
    // The records handed in, searched here; each kind it answers is its own lane.
    records: async (lane, { question }) => {
      if (fields.records === undefined) throw Object.assign(new Error('No records were handed in.'), { code: 'no_records' });
      return searchRecords(given, { question, type: fields.type, limit: fields.limit }).map(hit => ({ start: 0, end: 0, ...hit, source: lane.source, key: hit.id, lane: { ...lane, id: `${lane.id}:${hit.type}` } }));
    },
    // The Workshop tools handed in, searched by job words (searchTools).
    tools: async (lane, { question }) => searchTools(fields.tools, { question, limit: fields.limit }).map(hit => ({ start: 0, end: 0, ...hit, source: lane.source, key: hit.id, lane: { ...lane } })),
    // The file names handed in, searched here.
    files: async (lane, { question }) => {
      if (fields.files === undefined) throw Object.assign(new Error('No files were handed in.'), { code: 'no_files' });
      return searchFileNames(given, { question, limit: fields.limit }).map(hit => ({ start: 0, end: 0, ...hit, key: hit.id }));
    },
  };
  return finish(fields.question, { type: fields.type, places: fields.places, sources: fields.sources, matches: fields.matches, limit: Number.isInteger(fields.limit) ? fields.limit : config.limit });

  async function finish(question, { type = null, places = null, sources = null, matches = null, limit = config.limit } = {}, partial = null) {
    question = String(question ?? '').trim().slice(0, 500);
    const terms = [...new Set(words(question).filter(word => word.length >= config.min_word_length))];
    // The tools lane runs only when tools are handed in: a search without them answers exactly as before.
    const lanes = planned(type, { places, sources, matches }).filter(lane => lane.match !== 'tools' || fields.tools !== undefined);
    const given = partial ?? { answered: lanes.map(() => null), unavailable: [], pending: [], still_reading: Object.fromEntries(lanes.filter(lane => INDEX_MATCHES.has(lane.match)).map(lane => [lane.id, 1])) };
    const unavailable = [...given.unavailable], pending = [...given.pending];
    const participated = new Map(Object.entries(given.participated ?? {}));
    const report = {
      unavailable: (lane, reason, needs) => unavailable.push({ lane: lane.id, place: lane.place, source: lane.source, reason, ...(needs ? { needs } : {}) }),
      pending: lane => pending.push({ lane: lane.id, place: lane.place, source: lane.source }),
    };
    const answered = question ? await Promise.all(lanes.map(async (lane, at) => {
      if (INDEX_MATCHES.has(lane.match)) return given.answered[at] ?? [];
      try {
        const found = await mechanisms[lane.match](lane, { question, terms, report });
        if (!unavailable.some(item => item.lane === lane.id) && !pending.some(item => item.lane === lane.id)) participated.set(lane.id, [lane.id]);
        return found.map(hit => ({ lane, ...hit }));
      }
      catch (error) { report.unavailable(lane, reasonOf(error)); return []; }
    })) : [];
    // An index lane still reading is still working, as a picture model starting is: it is named pending, so every screen
    // and AI that reads this answer asks again rather than taking an empty answer as final (a follower still rebuilding).
    if (question) for (const lane of lanes) if (given.still_reading?.[lane.id] && !pending.some(item => item.lane === lane.id)) report.pending(lane);
    const found = answered.flat();
    const shown = found;
    const canonical = canonicalFiles([...new Set(shown.filter(hit => hit.identity).map(hit => hit.identity))]);
    const keyOf = hit => (hit.identity ? `file:${canonical.get(hit.identity)}` : hit.key);

    // Each lane's own ranking (its hits by score, one place per thing); a word-index lane whose best hit holds few of
    // the asked words sits this question out (the word gate, measured held-out in the find-by-meaning plan §9).
    const fusion = config.fusion ?? {};
    const rankings = new Map();
    for (const hit of shown) {
      const ranking = rankings.get(hit.lane.id) ?? { lane: hit.lane, keys: [], hits: [] };
      rankings.set(hit.lane.id, ranking);
      ranking.hits.push(hit);
    }
    for (const ranking of rankings.values()) {
      for (const hit of ranking.hits.sort((a, b) => b.score - a.score)) if (!ranking.keys.includes(keyOf(hit))) ranking.keys.push(keyOf(hit));
    }
    const satOut = [];
    for (const [id, { lane, keys }] of rankings) {
      if (lane.match !== 'words-in-index' || !terms.length || !Number.isFinite(fusion.word_confidence_floor)) continue;
      const best = shown.find(hit => hit.lane.id === id && keyOf(hit) === keys[0]);
      const held = words(best?.said ?? '');
      if (terms.filter(term => held.some(word => word.startsWith(term))).length / terms.length < fusion.word_confidence_floor) { rankings.delete(id); satOut.push({ lane: id, reason: 'its best match holds few of the asked words' }); }
    }
    const hits = shown.filter(hit => rankings.has(hit.lane.id));
    const weights = answers ? answers.weights([...rankings.keys()]) : {};
    const k = Number.isFinite(fusion.k) ? fusion.k : 60;
    // Reciprocal rank fusion: a thing is worth each lane's weight over (k + its rank in that lane), so lanes whose scores
    // are on different scales (words, one model, another model) add by rank, never by raw score.
    const fused = (laneId, key) => {
      const { lane, keys } = rankings.get(laneId);
      const rank = keys.indexOf(key) + 1;
      return { rank, value: lane.rank * (weights[laneId] ?? 1) / (k + rank) };
    };

    // One thing per file, record or service item; its places, its moments and its weight.
    const things = new Map();
    for (const hit of hits.sort((a, b) => b.score * b.lane.rank - a.score * a.lane.rank)) {
      const identity = hit.identity ? canonical.get(hit.identity) : null;
      const key = keyOf(hit);
      const thing = things.get(key) ?? { key, source: hit.lane.source, identity, hit, lanes: new Map(), ranks: {}, places: new Map(), moments: [] };
      things.set(key, thing);
      if (!thing.lanes.has(hit.lane.id)) { const { rank, value } = fused(hit.lane.id, key); thing.lanes.set(hit.lane.id, value); thing.ranks[hit.lane.id] = rank; }
      if (!thing.places.has(hit.lane.place)) thing.places.set(hit.lane.place, { place: hit.lane.place, label: placeLabel[hit.lane.place] ?? hit.lane.place, ...(hit.timed ? { start: round(hit.start, 2) } : {}), said: hit.said ?? null, score: round(hit.score) });
      if (hit.timed || !thing.moments.length) {
        const evidence = { place: hit.lane.place, score: hit.score, start: hit.start, end: hit.end, ...hit.evidence };
        const near = thing.moments.find(moment => (moment.timed && hit.timed && Math.abs(moment.start - hit.start) < config.merge_seconds) || (!moment.timed && !hit.timed));
        if (near) { if (!near.places.includes(hit.lane.place)) near.places.push(hit.lane.place); near.said ??= hit.said; near.evidence.push(evidence); }
        else if (thing.moments.length < config.moments_per_thing) thing.moments.push({ start: round(hit.start, 2), end: round(hit.end, 2), timed: Boolean(hit.timed), said: hit.said ?? null, places: [hit.lane.place], evidence: [evidence] });
      }
    }
    const ranked = [...things.values()].map(thing => ({ ...thing, score: [...thing.lanes.values()].reduce((sum, value) => sum + value, 0) }))
      .sort((a, b) => b.score - a.score).slice(0, limit);
    // A result is the hit its owner answered (its title, said and address), with where it was found and its fused score.
    const results = ranked.map(thing => {
      const { lane: _lane, key: _key, ...hit } = thing.hit;
      const foundIn = [...thing.places.keys()];
      return {
        ...hit, found_in: foundIn, places: [...thing.places.values()], moments: thing.moments,
        said: hit.said ?? [...thing.places.values()].find(place => place.said)?.said ?? null,
        score: round(thing.score, 5),
      };
    });
    return { question, terms, results, unavailable, pending, sat_out: satOut };
  }
}

// GET /work/api/search?q=&places=&sources=&matches=&limit= as the page asks it (old src/worker.mjs:865 handed it to the
// account's Namespace resource, src/namespace.mjs:2127 `namespaceSearch(q ?? '', searchOptions(params))`): the route's
// { path, method, query } in, its { status, body } out. searchOptions is old src/search.mjs:2221: places, sources and
// matches as comma lists, limit a whole number above 0, at most 200. The records, files and query_vectors are handed in
// beside the request, as searchEverything takes them, with the same host. Any other request is no route of this one.
export async function answerTheSearchRoute(input, host = {}) {
  const { path, method, query, records, files, query_vectors: queryVectors } = input && typeof input === 'object' ? input : {};
  if (method !== 'GET' || path !== '/search') return { status: 404, body: { error: 'Not found' } };
  const asked = query && typeof query === 'object' ? query : {};
  const list = name => (typeof asked[name] === 'string' && asked[name] ? asked[name].split(',').map(item => item.trim()).filter(Boolean) : null);
  const limit = Number(asked.limit);
  try {
    return { status: 200, body: await searchEverything({ question: typeof asked.q === 'string' ? asked.q : '', places: list('places'), sources: list('sources'), matches: list('matches'),
      ...(Number.isInteger(limit) && limit > 0 ? { limit: Math.min(limit, 200) } : {}), records, files, ...(queryVectors === undefined ? {} : { query_vectors: queryVectors }) }, host) };
  } catch (error) {
    return { status: 500, body: { error: error.message } };
  }
}
