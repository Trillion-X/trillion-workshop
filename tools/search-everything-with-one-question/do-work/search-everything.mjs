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
// - The lanes are the engine's two storage reads (read-data/settings.json `lanes`): records:search at @own-records,
//   whose every kind is its own lane, and the files' name search at @namespace (only when no `type` is asked). A hit
//   keeps the lane its owner gave it (one per record kind), so kinds are ranked apart as the engine ranked them.
// - The index lanes, partial answers, hidden files, canonical file identities, candidate fusion sessions and learned
//   weights read the old Worker's SQL; the Workshop has none of them, so `given` starts empty, nothing is hidden, a file
//   is its own canonical identity and every weight is 1.
// - A refusal of the records' search is the answer's refusal (thrown), as the engine kept it; the files' refusal is
//   named `unavailable`, never guessed.
// - A result is its owner's hit (with its address) plus found_in, places, moments, said and the fused score.
import settings from '../read-data/settings.json' with { type: 'json' };

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

// `{ question, type?, limit? }` in; `{ question, terms, results, unavailable, pending, sat_out }` out.
export async function searchEverything(input, { door }) {
  const fields = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  let refusal = null;
  const mechanisms = {
    // The records door's search; each kind it answers is its own lane.
    records: async (lane, { report }) => {
      let answer;
      try { answer = await door.search({ question: fields.question, ...(fields.type === undefined ? {} : { type: fields.type }), ...(fields.limit === undefined ? {} : { limit: fields.limit }) }); }
      catch (error) { refusal = error; return []; }
      for (const item of answer?.unavailable ?? []) report.passed.unavailable.push(item);
      for (const item of answer?.pending ?? []) report.passed.pending.push(item);
      return (answer?.results ?? []).map(hit => ({ start: 0, end: 0, ...hit, key: hit.id, lane: { ...lane, id: `${lane.id}:${hit.type}` } }));
    },
    // The files' name search, asked with only the question and the limit.
    files: async (lane, { question }) => {
      const asked = { question, ...(Number.isInteger(fields.limit) ? { limit: fields.limit } : {}) };
      const answer = await door.files(lane.operation, asked);
      return (answer?.results ?? []).map(hit => ({ start: 0, end: 0, ...hit, key: hit.id }));
    },
  };
  return finish(fields.question, { type: fields.type, places: fields.places, sources: fields.sources, matches: fields.matches, limit: Number.isInteger(fields.limit) ? fields.limit : config.limit });

  async function finish(question, { type = null, places = null, sources = null, matches = null, limit = config.limit } = {}, partial = null) {
    question = String(question ?? '').trim().slice(0, 500);
    const terms = [...new Set(words(question).filter(word => word.length >= config.min_word_length))];
    const lanes = planned(type, { places, sources, matches });
    const given = partial ?? { answered: lanes.map(() => null), unavailable: [], pending: [], still_reading: Object.fromEntries(lanes.filter(lane => INDEX_MATCHES.has(lane.match)).map(lane => [lane.id, 1])) };
    const unavailable = [...given.unavailable], pending = [...given.pending];
    const participated = new Map(Object.entries(given.participated ?? {}));
    const report = {
      unavailable: (lane, reason) => unavailable.push({ lane: lane.id, place: lane.place, source: lane.source, reason }),
      pending: lane => pending.push({ lane: lane.id, place: lane.place, source: lane.source }),
      passed: { unavailable, pending },
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
    if (refusal) throw refusal;
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
    for (const hit of [...shown].sort((a, b) => b.score - a.score)) {
      const ranking = rankings.get(hit.lane.id) ?? { lane: hit.lane, keys: [] };
      rankings.set(hit.lane.id, ranking);
      if (!ranking.keys.includes(keyOf(hit))) ranking.keys.push(keyOf(hit));
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
        const near = thing.moments.find(moment => (moment.timed && hit.timed && Math.abs(moment.start - hit.start) < config.merge_seconds) || (!moment.timed && !hit.timed));
        if (near) { if (!near.places.includes(hit.lane.place)) near.places.push(hit.lane.place); near.said ??= hit.said; }
        else if (thing.moments.length < config.moments_per_thing) thing.moments.push({ start: round(hit.start, 2), end: round(hit.end, 2), timed: Boolean(hit.timed), said: hit.said ?? null, places: [hit.lane.place] });
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
// matches as comma lists, limit a whole number above 0, at most 200. Any other request is no route of this one.
export async function answerTheSearchRoute(input, { door }) {
  const { path, method, query } = input && typeof input === 'object' ? input : {};
  if (method !== 'GET' || path !== '/search') return { status: 404, body: { error: 'Not found' } };
  const asked = query && typeof query === 'object' ? query : {};
  const list = name => (typeof asked[name] === 'string' && asked[name] ? asked[name].split(',').map(item => item.trim()).filter(Boolean) : null);
  const limit = Number(asked.limit);
  try {
    return { status: 200, body: await searchEverything({ question: typeof asked.q === 'string' ? asked.q : '', places: list('places'), sources: list('sources'), matches: list('matches'),
      ...(Number.isInteger(limit) && limit > 0 ? { limit: Math.min(limit, 200) } : {}) }, { door }) };
  } catch (error) { return { status: 500, body: { error: error.message } }; }
}
