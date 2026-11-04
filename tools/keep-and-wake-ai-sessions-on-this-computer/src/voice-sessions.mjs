// src/voice-sessions.mjs
//
// Where in time each app heard speakers nobody has named yet, kept as one small record per stretch of listening, so the
// voices waiting on the person (messages.unnamedSpeakers) are found from the newest stretches instead of from every
// (label, app) group a store ever heard.
//
// Purpose
//   The voices read takes the newest `scan` unnamed turns and cuts them into sessions. Found through each (label, app)
//   group of the speaker index, it cost about 20,000 statements and 230,000 rows a read on the founder's store and ran
//   out of CPU, resetting every call beside it (2026-10-16). An index of every unnamed turn made that flat but kept a
//   key per turn, about 150 bytes, which a listening store cannot afford (the store-month ceiling, 2026-10-16). A
//   stretch row costs a few writes a day however many turns it covers.
//
// Non-negotiable invariants
//   1. One row per stretch: `voice-session:<id>` holds { app, first_at, labels }. The stretches of one app cover its
//      time without gaps: a row covers from its first_at up to the next row's first_at (the app's newest row has no
//      end), and lists the label of every unnamed turn of `app` (its speaker starts with one of the voices
//      `label_starts`, DATA) in that span.
//   2. A row is a covering range, never the answer: the turns are read from the speaker index inside it and cut into
//      sessions as before, so a turn renamed, erased or moved afterwards leaves a row wider than its turns and the
//      answer exact.
//   3. A row is written only when its stretch hears a label it does not list: a new label at the newest end of an app
//      whose newest stretch already lists `stretch_labels` (DATA) starts the next stretch there, so no stretch makes
//      a read open many labels; one heard inside an older stretch is added to it, up to `labels_most`, past which
//      the row says `labels_over` and the read says it is preparing rather than answer without it. Rows are indexed
//      by (app, first_at); only a turn older than every row of its app moves a first_at. A voice heard every few
//      minutes writes nothing after its first turn.
//   4. A store that kept turns before these rows builds them once, newest message first, a bounded page at a time
//      (`step`); until that finishes the read answers from the rows only when they surely hold its whole window, and
//      otherwise says the voices are still being prepared (a VoicesPreparing error), never that there are none.
//
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import waitingOnYou from './waiting-on-you.json' with { type: 'json' };

const TYPE = 'voice-session';
const MESSAGE = 'message';
const BUILD = 'setting:voice-sessions-build';
const BUILD_VERSION = 1;
const DATA = waitingOnYou.sources.voices;
const MINUTE = 60_000;

export class VoicesPreparing extends Error {
  constructor() { super(DATA.sessions.preparing); this.code = 'voices_preparing'; }
}

const iso = ms => new Date(ms).toISOString();
const timeOf = value => typeof value === 'string' ? Date.parse(value) : NaN;
const rowIdOf = (app, at) => `${TYPE}:${bytesToHex(blake3(new TextEncoder().encode(JSON.stringify([app, at])))).slice(0, 32)}`;

// The labels the rows keep: the voices DATA starts, exactly.
export const VOICE_SESSION_STARTS = DATA.label_starts;
export const keptLabel = speaker => typeof speaker === 'string' && VOICE_SESSION_STARTS.some(start => speaker.startsWith(start));
// Whether a read limited to `starts` is answered by the rows: every start it asks lies inside one the rows keep.
export const sessionsCover = starts => Array.isArray(starts) && starts.length > 0
  && starts.every(start => typeof start === 'string' && VOICE_SESSION_STARTS.some(kept => start.startsWith(kept)));

export function voiceSessions(eeaf, { fields = eeaf.fields ?? null, now = () => Date.now(), settings = DATA } = {}) {
  const stretchLabels = settings.sessions.stretch_labels, labelsMost = settings.sessions.labels_most;

  const latestAtOrBefore = (app, t) => eeaf.scan(TYPE, 'app-started', { equal: [app], to: iso(t), reverse: true, limit: 1 })[0] ?? null;
  const firstAfter = (app, t) => eeaf.scan(TYPE, 'app-started', { equal: [app], after: iso(t), limit: 1 })[0] ?? null;

  // The row writes that keep invariant 1 for `turns` ({ app, speaker, at }), taken in time order. `known` holds the
  // rows read or changed in this batch, `changed` the ones to write; per app, `span` remembers the stored rows a read
  // already placed around a time, so a batch of one stretch reads it once.
  const rowsFor = turns => {
    const known = new Map(), changed = new Set(), apps = new Map();
    const rowOf = id => { if (!known.has(id)) known.set(id, eeaf.read(id)); return known.get(id); };
    const ordered = turns.filter(turn => keptLabel(turn.speaker) && typeof turn.app === 'string' && turn.app && Number.isFinite(timeOf(turn.at)))
      .sort((a, b) => timeOf(a.at) - timeOf(b.at));
    for (const { app, speaker, at } of ordered) {
      const t = timeOf(at);
      const mine = apps.get(app) ?? { rows: new Map(), spans: [] };
      apps.set(app, mine);
      // The stored rows around t: the latest starting at or before it and the first starting after it.
      let span = mine.spans.find(held => held.from <= t && t < held.until);
      if (!span) {
        const before = latestAtOrBefore(app, t), after = firstAfter(app, t);
        span = { from: before ? timeOf(before.values[1]) : -Infinity, until: after ? timeOf(after.values[1]) : Infinity, before: before?.id ?? null, after: after?.id ?? null };
        mine.spans.push(span);
        if (span.before) mine.rows.set(span.before, timeOf(rowOf(span.before)?.first_at));
        if (span.after) mine.rows.set(span.after, timeOf(rowOf(span.after)?.first_at));
      }
      // Rows this batch made or moved count beside the stored ones.
      const starts = [...mine.rows].filter(([id]) => known.get(id)).map(([id]) => [id, timeOf(known.get(id).first_at)]);
      const covering = starts.filter(([, from]) => from <= t).sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
      const newer = starts.some(([, from]) => from > t);
      const make = () => {
        const id = rowIdOf(app, at);
        known.set(id, { app, first_at: at, labels: [speaker] });
        changed.add(id); mine.rows.set(id, t);
      };
      // Adds the label to a row that does not list it; moving first_at back when it reaches back to an older turn.
      const join = (id, first_at) => {
        const held = known.get(id);
        if (held.labels?.includes(speaker) && first_at === held.first_at) return;
        const row = { ...held, labels: [...(held.labels ?? [])], first_at };
        if (!row.labels.includes(speaker)) {
          if (row.labels.length < labelsMost) row.labels.push(speaker); else row.labels_over = true;
        }
        known.set(id, row); changed.add(id); mine.rows.set(id, timeOf(first_at));
      };
      const listed = id => known.get(id).labels?.includes(speaker);
      const full = id => (known.get(id).labels?.length ?? 0) >= stretchLabels;
      // Whether no turn of a row's labels was heard after t: only then may a stretch end at t.
      const quietAfter = id => (known.get(id).labels ?? []).every(label => !eeaf.scan(MESSAGE, 'speaker', { equal: [label, app], after: at, limit: 1 }).length);
      if (covering) {
        // A new label at the newest end of a stretch that lists enough starts the next one, once it is sure nothing of
        // that stretch was heard after it (a read of each listed label, only when a full stretch hears a new one).
        if (!newer && !listed(covering) && full(covering) && quietAfter(covering)) make();
        else join(covering, known.get(covering).first_at);
        continue;
      }
      // Older than every row of its app: the oldest row reaches back to it, unless it lists enough and not this label.
      const oldest = starts.sort((x, y) => x[1] - y[1])[0]?.[0] ?? null;
      if (oldest && (listed(oldest) || !full(oldest))) join(oldest, at);
      else make();
    }
    return [...changed].map(id => ({ id, type: TYPE, value: known.get(id) }));
  };

  const buildState = () => eeaf.read(BUILD)?.value ?? null;
  const built = () => buildState()?.done === true && buildState()?.version === BUILD_VERSION;

  // The newest `scan` turns whose speaker matches `unnamed` and starts with one of `starts`, newest first, merged from
  // the newest stretches: each listed label of a stretch is read from the speaker index a page at a time, only once
  // its next turn is the newest left, and a stretch is opened only once it could hold the next turn. Answers
  // { turns: [[id, { app, speaker, at }]], candidates } or throws VoicesPreparing.
  const window = ({ unnamed, starts, scan, gap: sessionGap }) => {
    const state = buildState();
    const done = state?.done === true && state.version === BUILD_VERSION;
    // Until the build finishes only turns newer than its cursor (and every turn written since) are surely in a row.
    const coveredFrom = done ? -Infinity : state?.version === BUILD_VERSION && typeof state.before_at === 'string' ? timeOf(state.before_at) : Infinity;
    const wanted = label => starts.some(start => label.startsWith(start)) && unnamed.test(label);
    const newer = (a, b) => b.at < a.at ? -1 : b.at > a.at ? 1 : b.app < a.app ? -1 : b.app > a.app ? 1
      : b.speaker < a.speaker ? -1 : b.speaker > a.speaker ? 1 : b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
    const heap = [];
    const push = item => {
      heap.push(item);
      for (let at = heap.length - 1; at > 0;) { const up = (at - 1) >> 1; if (newer(heap[at], heap[up]) >= 0) break; [heap[at], heap[up]] = [heap[up], heap[at]]; at = up; }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        for (let at = 0; ;) {
          const left = at * 2 + 1, right = left + 1;
          let best = at;
          if (left < heap.length && newer(heap[left], heap[best]) < 0) best = left;
          if (right < heap.length && newer(heap[right], heap[best]) < 0) best = right;
          if (best === at) break;
          [heap[at], heap[best]] = [heap[best], heap[at]]; at = best;
        }
      }
      return top;
    };
    let candidates = new Set();
    const note = id => { if (candidates !== null) { candidates.add(id); if (candidates.size > 10_000) candidates = null; } };
    // One label of one stretch, newest first; a page of one shared time is widened.
    const nextOf = stream => {
      for (let limit = stream.page; ; limit *= 2) {
        const bound = stream.lastAt !== null ? { to: stream.lastAt } : stream.end !== null ? { before: stream.end } : {};
        const found = eeaf.scan(MESSAGE, 'speaker', { equal: [stream.speaker, stream.app], from: stream.from, ...bound, reverse: true, limit });
        const fresh = stream.lastAt === null ? found : found.filter(({ id, values: [, , at] }) => at !== stream.lastAt || id < stream.lastId);
        stream.page = Math.min(limit * 2, 128);
        if (fresh.length || found.length < limit) {
          stream.more = found.length === limit;
          for (const { id } of fresh) note(id);
          stream.buffer = fresh.map(({ id, values: [, , at] }) => ({ id, at }));
          return;
        }
      }
    };
    const advance = stream => {
      if (!stream.buffer.length && stream.more) nextOf(stream);
      const next = stream.buffer.shift();
      if (!next) return;
      stream.lastAt = next.at; stream.lastId = next.id;
      push({ stream, id: next.id, at: next.at, app: stream.app, speaker: stream.speaker });
    };
    // Each app's stretches, newest first: an app's newest is opened at once (it has no end), and an older one only once
    // the newest turn waiting is older than where the next newer stretch starts.
    // Each chain reads its older stretches a page at a time (ids from the index, rows in one read).
    const chains = eeaf.lastPerGroup(TYPE, 'app-started', { depth: 1 }).map(({ id, values: [app] }) => ({ app, queue: [id], more: true, frontier: null }));
    const readRows = ids => eeaf.readMany ? eeaf.readMany(ids) : new Map(ids.map(id => [id, eeaf.read(id)]));
    const ready = chain => {
      if (!chain.queue.length && chain.more && chain.frontier !== null) {
        const page = eeaf.scan(TYPE, 'app-started', { equal: [chain.app], before: chain.frontier, reverse: true, limit: 8 });
        chain.more = page.length === 8;
        const rows = readRows(page.map(({ id }) => id));
        chain.queue = page.map(({ id }) => rows.get(id)).filter(Boolean);
      }
      if (typeof chain.queue[0] === 'string') chain.queue[0] = eeaf.read(chain.queue[0]);
      if (chain.queue.length && !chain.queue[0]) chain.queue.shift();
      if (!chain.queue.length && chain.frontier === null) chain.more = false;
      return chain.queue.length > 0;
    };
    const open = chain => {
      const row = chain.queue.shift();
      if (row.labels_over) throw new VoicesPreparing();
      const streams = (row.labels ?? []).filter(wanted).map(speaker => ({ app: chain.app, speaker, from: row.first_at, end: chain.frontier, lastAt: null, lastId: null, page: 8, buffer: [], more: true }));
      // Only the first small page of the labels in this opened stretch is read
      // together. Later pages still follow the existing newest-first heap, so
      // batching cannot pull in older stretches or a label's complete history.
      for (let start = 0; start < streams.length; start += stretchLabels) {
        const batch = streams.slice(start, start + stretchLabels);
        if (typeof eeaf.scanSelectedValues !== 'function') { for (const stream of batch) advance(stream); continue; }
        const found = eeaf.scanSelectedValues(MESSAGE, 'speaker', {
          values: batch.map(stream => stream.speaker), suffix: [chain.app], from: row.first_at,
          ...(chain.frontier === null ? {} : { before: chain.frontier }), reverse: true, limit: 8,
        });
        const pages = new Map(batch.map(stream => [stream.speaker, []]));
        for (const { id, values: [speaker, , at] } of found) { note(id); pages.get(speaker).push({ id, at }); }
        for (const stream of batch) {
          stream.buffer = pages.get(stream.speaker);
          stream.more = stream.buffer.length === stream.page;
          stream.page *= 2;
          advance(stream);
        }
      }
      chain.frontier = row.first_at;
    };
    const turns = [];
    for (;;) {
      for (const chain of chains) while ((chain.frontier === null || !heap.length || chain.frontier > heap[0].at) && ready(chain)) open(chain);
      if (!heap.length || turns.length >= scan) break;
      const item = pop();
      // A turn older than what the build has reached may have a neighbour no row holds yet.
      if (timeOf(item.at) - sessionGap <= coveredFrom) throw new VoicesPreparing();
      turns.push([item.id, { app: item.app, speaker: item.speaker, at: item.at }]);
      advance(item.stream);
    }
    // A window that ran out of stretches before the build finished may be missing older turns.
    if (!done && turns.length < scan) throw new VoicesPreparing();
    return { turns, candidates };
  };

  // Builds the rows for turns kept before them: a page of the newest messages not yet walked per call, newest first.
  const step = ({ pages = settings.sessions.build_pages } = {}) => {
    let state = buildState();
    if (state?.done === true && state.version === BUILD_VERSION) return { done: true };
    if (state?.version !== BUILD_VERSION) state = { version: BUILD_VERSION, before: null, before_at: null, done: false };
    for (let page = 0; page < pages; page += 1) {
      const ids = eeaf.ids(MESSAGE, { ...(state.before ? { before: state.before } : {}), limit: settings.sessions.build_page });
      if (!ids.length) {
        state = { ...state, done: true };
        eeaf.write([{ id: BUILD, type: 'setting', value: { value: state } }], { actor: { by: 'voice-sessions' }, unwatched: true });
        return { done: true };
      }
      const own = fields ? fields.fieldsOf(MESSAGE, ids, ['app', 'speaker', 'at']) : new Map(ids.map(id => [id, eeaf.read(id)]));
      const turns = ids.map(id => own.get(id)).filter(Boolean).map(({ app, speaker, at }) => ({ app, speaker, at }));
      const oldest = ids.map(id => own.get(id)?.at).filter(at => Number.isFinite(timeOf(at))).sort()[0] ?? state.before_at;
      state = { ...state, before: ids.at(-1), before_at: state.before_at && oldest ? (oldest < state.before_at ? oldest : state.before_at) : oldest };
      eeaf.write([...rowsFor(turns), { id: BUILD, type: 'setting', value: { value: state } }], { actor: { by: 'voice-sessions' }, unwatched: true });
    }
    return { done: false };
  };

  return {
    rowsFor,
    window,
    built,
    started: () => buildState()?.version === BUILD_VERSION,
    nextAt: () => (built() ? null : now()),
    step,
  };
}
