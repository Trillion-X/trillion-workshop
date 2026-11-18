// src/steps-ais-leave.mjs
//
// Purpose
//   What any AI leaves the person to do reaches them. Every app whose words Trillion records (Codex, Claude Code,
//   ChatGPT, Muse, anything that calls record_messages) is read here: the last AI message of each turn is asked of the
//   small classifier on the person's own computer ("does this leave the person something to do?"), and each yes is
//   handed to the person's AIs, once per message, to run the default workflow its DATA names by purpose, which does every step
//   Trillion can and keeps only what truly needs the person as a fully explained Waiting on you row (so it gets every
//   nudge, the hold, Home, the phone and the Mac). Run as tool:weigh-steps-ais-left-you by the starting rule
//   starting:weigh-steps-ais-leave-you when an AI's message is recorded, and again once when a run leaves work open
//   (`again`); its DATA is src/steps-ais-leave.json.
//
// Non-Negotiable Invariants
//   1. Nothing here names an app, a model, a person or a product: which speakers are AIs, how long a quiet
//      conversation waits, the question asked and the job words are DATA.
//   2. A turn end is an AI message whose next message in its conversation (app + conversation_id) is not an AI's, or
//      that has stood `quiet_minutes` with nothing after it. Messages in the middle of a turn are never asked about.
//   3. Trillion pays for no model here: the question goes only to the person's own computer (the classify routes), at
//      the priority classify.priority names. When no computer answers, nothing is guessed: the place is kept before
//      that turn end, and one more run is named for it on the retry ladder (`again`, see nextTry): the tries are fixed
//      times counted from that message's own time, so every run waiting on it names the same next run, and once a try
//      has passed the next one is named, until the computer answers.
//      The computer is asked once a try, not once a reply: a try that no computer answers keeps `silent_until` (the next
//      try on the ladder) in the kept place, no ask is made before it, and the completed replies it could not weigh wait
//      together in the kept place (`waiting`, oldest first) under one retry run, which weighs up to `most_per_run` of them
//      when the try comes. Before (2026-10-08) every unanswered reply asked again and named a retry run of its own, every
//      hour for ever, so the runs due grew with the backlog (about 5,100 statements a wake) and each ask wrote its own
//      observation and spend rows.
//   4. One message is one job at most (once_per), however often it is weighed.
//   5. The place moves only past messages that were decided, so a turn still being written is read again next run.
//   6. Nothing runs on a clock while no AI writes: a run is started by an AI's message, and a run that leaves a turn
//      end open (still inside the quiet time, or past the run's page or count) names the one run it needs next
//      (`again`: when, and a key made of that message and that time, the same for every run leaving that same message
//      open until then, so it is one run; a key never names a different time, which the Workshop would refuse).
//      A store with no AI messages costs nothing here (test/store-month.test.mjs held it to its ceilings).
//   7. Two roads, one weigher: a completed reply (final_reply) is weighed by the run its own record starts, at once;
//      every other turn end (an app that marks no final reply) is weighed by the sweep, which each reply run wakes and
//      which skips completed replies, so nothing is asked about twice and no app is left unread.
//   8. What a turn end becomes is attention's to decide first (src/attention.mjs, the person's own rules or the starting
//      rules): words attention keeps as context, such as brought-in history (an imported chat, a backlog caught up,
//      src/brought-in.mjs), are decided without asking the computer and never handed on; only words attention opens are
//      asked of the classifier.
//
// Key Concepts
//   turnEnds(rows, options)      pure: the turn ends among a page of message rows (oldest first) and the first row still
//                                undecided.
//   nextTry(fromMs, nowMs)       pure: the next try on the retry ladder counted from fromMs (DATA classify.retry, the
//                                scheduler's own retry shape), the first one after nowMs.
//   weighStepsAisLeft(io)        one run: read, find turn ends, ask, hand on, keep the place.
//
import settings from './steps-ais-leave.json' with { type: 'json' };

export { settings as stepsAisLeaveSettings };

const MINUTE_MS = 60_000;
const fill = (text, values) => String(text).replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
const threadOf = row => `${row.app ?? ''}\u0000${row.conversation_id ?? ''}`;

/**
 * The turn ends among `rows` (oldest first, each { id, app, conversation_id, speaker, recorded_at }): an AI row whose
 * next row in its thread is not an AI's, or, with no next row on this page, one older than the quiet time (on a full
 * page that row may have a next one past the page; it is weighed anyway, so a page never stops the place from moving).
 * `open` is the index of the first row still undecided (rows.length when none is).
 * → { ends: [index], open }
 */
export function turnEnds(rows, { now, quietMs, aiSpeakers }) {
  const isAi = row => aiSpeakers.includes(row.speaker);
  const next = new Map();
  const last = new Map();
  rows.forEach((row, index) => {
    const thread = threadOf(row);
    if (last.has(thread)) next.set(last.get(thread), index);
    last.set(thread, index);
  });
  const ends = [];
  let open = rows.length;
  rows.forEach((row, index) => {
    if (!isAi(row)) return;
    if (next.has(index)) { if (!isAi(rows[next.get(index)])) ends.push(index); return; }
    if (now - Date.parse(row.recorded_at) >= quietMs) { ends.push(index); return; }
    open = Math.min(open, index);
  });
  return { ends: ends.filter(index => index < open), open };
}

/**
 * The next try for a turn end the computer has not answered, counted from `fromMs` (that message's time): the first
 * try `first_after_seconds` after it, each next one `factor` times further, never more than `longest_after_seconds`
 * apart (src/steps-ais-leave.json classify.retry, the shape src/scheduler.mjs retries with). → the first try after
 * `nowMs`, in ms. Every run asking between two tries gets the same answer, so they name one run.
 */
export function nextTry(fromMs, nowMs, retry = settings.classify.retry) {
  let gap = retry.first_after_seconds * 1000;
  let at = fromMs + gap;
  while (at <= nowMs) {
    gap = Math.min(gap * retry.factor, retry.longest_after_seconds * 1000);
    at += gap;
  }
  return at;
}
// `notBeforeMs`: a computer that stayed silent is not asked before its kept try, so no run is named earlier than that.
const retryOf = (prefix, row, nowMs, notBeforeMs = 0) => {
  const at = new Date(Math.max(nextTry(Date.parse(row.recorded_at), nowMs), notBeforeMs)).toISOString();
  return { at, key: `${prefix}:${row.id}:${at}` };
};
const byTime = (a, b) => String(a.recorded_at ?? '').localeCompare(String(b.recorded_at ?? ''));

/** What the classifier and the AI read of a message: all of a short one, the opening and closing of a long one. */
export function excerpt(text, { opening, closing } = settings.text_chars) {
  const words = String(text ?? '').trim();
  return words.length <= opening + closing ? words : `${words.slice(0, opening).trimEnd()} … ${words.slice(-closing).trimStart()}`;
}

/** The classifier's question for one message, in the shape the classify routes take (src/model-routes.json). */
export function classifyInput(text, app) {
  const { state, question, means } = settings.classify;
  return { state: fill(state, { text, app }), questions: { verdict: { type: 'noul', instructions: question, criteria: means } } };
}

/**
 * One run. `io`:
 *   fields       the store's field reads (fields.after over messages)
 *   readMessage(id)  one message whole, or null
 *   ask(input)   the person's own computer asked one classify input: a probability 0 to 1, or null when none answers
 *   handOff(job) agents.handOff: { handoff_id }
 *   attention(row)   async: what attention makes of one message ({ ...row, text }): { opens, rule }; absent, it opens
 *   kept         what the last run kept ({ through, through_id?, at, last, waiting: [{ id, recorded_at }], silent_until }) or null
 *   keptNow()    what is kept at this moment (runs overlap while the computer is asked); absent, `kept`
 *   keep(value)  keeps it for the next run
 *   now()        the time in ms
 *   onDecided(id, source) optional owner callback; source is the exact words/metadata decided, including empty/context
 * → { weighed: [{ message_id, app, verdict, handoff_id? }], through, said, again: { at, key, message_id? } | null, read, newest_read }
 *   (read: messages read past the place this run; newest_read: the newest of their recorded_at, or null)
 */
export async function weighStepsAisLeft({ fields, readMessage, ask, handOff, kept, keptNow = () => kept, keep, attention = null, messageId = null, now = () => Date.now(), onDecided = null }) {
  const at = now();
  // The computer stayed silent at its last try: it is not asked again before the next one, by any reply or sweep.
  const silent = Date.parse(kept?.silent_until ?? '') > at;
  const weighOne = async row => {
    const source = { ...row, text: readMessage(row.id)?.text };
    const text = excerpt(source.text);
    const decided = result => { onDecided?.(row.id, source); return result; };
    if (!text) return decided({ empty: true });
    const app = row.app ?? 'an AI';
    // Attention first: words it keeps as context (brought-in history among them) are decided here and asked of no one.
    if (attention && (await attention({ ...row, text }))?.opens === false) return decided({ context: true });
    if (silent) return { waiting: true, silent: true };
    const probability = await ask(classifyInput(text, app));
    if (probability === null || probability === undefined || !Number.isFinite(Number(probability))) return { waiting: true };
    const verdict = Number(probability) >= settings.classify.act_at ? 'leaves-a-step' : 'nothing';
    const done = { message_id: row.id, app, verdict };
    if (verdict === 'leaves-a-step') {
      const values = { app, message_id: row.id, text, purpose: settings.hand.purpose };
      const once = fill(settings.hand.once_per, values);
      const handed = handOff({
        job: fill(settings.hand.job, values), said: fill(settings.hand.said, values), from_agent: settings.hand.from_agent,
        priority: settings.hand.priority,
        once_per: once, request_key: once,
        input: { said_by_ai: { message_id: row.id, app, conversation_id: row.conversation_id ?? null }, purpose: settings.hand.purpose, said: text, source: row.id, asked_by: app },
      });
      done.handoff_id = handed?.handoff_id ?? null;
    }
    return decided({ done });
  };
  // A completed reply has its own recorded event. Weigh it directly so an older transcript sweep cannot hold it
  // behind hundreds of unrelated messages. The sweep still heals missed events; handOff's message key dedupes both.
  if (messageId) {
    // A kept message holds no id of its own; the run weighs it by the id it was handed.
    const kept_message = readMessage(messageId);
    const row = kept_message ? { ...kept_message, id: messageId } : null;
    if (!row || !settings.ai_speakers.includes(row.speaker) || row.final_reply !== true) return { weighed: [], through: kept?.through ?? null, said: settings.words.nothing, again: null, read: 0, newest_read: null };
    // This reply and the ones already waiting, oldest first: one run weighs them all (up to most_per_run) while the
    // computer answers, and while it stays silent they wait together under one retry run, never one run each.
    const queue = [{ id: messageId, recorded_at: row.recorded_at }, ...(kept?.waiting ?? []).filter(item => item.id !== messageId)].sort(byTime);
    const weighed = [];
    const stillWaiting = [];
    let failed = false;
    for (const [n, item] of queue.entries()) {
      if (silent || failed || n >= settings.most_per_run) { stillWaiting.push(item); continue; }
      const held = item.id === messageId ? row : readMessage(item.id);
      const reply = held && settings.ai_speakers.includes(held.speaker) && held.final_reply === true ? { ...held, id: item.id } : null;
      const one = reply ? await weighOne(reply) : { empty: true };
      if (one.waiting) { failed = true; stillWaiting.push(item); continue; }
      if (!reply) onDecided?.(item.id, null);
      if (one.done) weighed.push(one.done);
    }
    // What is kept now, not what was read at the start: another reply's run may have joined the waiting meanwhile.
    const latest = keptNow();
    const decided = new Set(queue.map(item => item.id));
    const waiting = [...(latest?.waiting ?? []).filter(item => !decided.has(item.id)), ...stillWaiting].sort(byTime).slice(-settings.waiting_max);
    const silentUntil = silent ? kept.silent_until : failed && waiting.length ? new Date(nextTry(Date.parse(waiting[0].recorded_at) || at, at)).toISOString() : null;
    // The place is written only when what waits, or until when, changed: a reply the computer answers writes nothing.
    if (silentUntil !== (latest?.silent_until ?? null) || waiting.length !== (latest?.waiting ?? []).length || waiting.some((item, n) => item.id !== latest.waiting[n].id)) {
      keep({ ...latest, waiting, silent_until: silentUntil });
    }
    const more = !silent && !failed && waiting.length > 0;
    const again = !waiting.length ? null
      : silentUntil ? { at: silentUntil, key: `steps-ais-leave-retry:${waiting[0].id}:${silentUntil}`, message_id: waiting[0].id }
        : more ? { at: new Date(at).toISOString(), key: `steps-ais-leave-again:${waiting[0].id}:${new Date(at).toISOString()}`, message_id: waiting[0].id } : null;
    return { weighed, through: kept?.through ?? null,
      said: silent || failed ? settings.words.reply_waits
        : weighed.length ? fill(settings.words.weighed, { count: weighed.length, turns: weighed.length === 1 ? settings.words.turn : settings.words.turns, left: weighed.filter(item => item.verdict === 'leaves-a-step').length }) : settings.words.nothing,
      again, read: 1, newest_read: row.recorded_at ?? null };
  }
  const since = kept?.through ?? new Date(at - settings.first_look_minutes * MINUTE_MS).toISOString();
  const sinceId = kept?.through_id;
  if (sinceId !== undefined && sinceId !== null && (typeof sinceId !== 'string' || !sinceId || sinceId.includes('\u0000') || !kept?.through)) {
    throw new Error('The kept message place needs its timestamp and record id together.');
  }
  const incomingPlace = { through: since, ...(sinceId ? { through_id: sinceId } : {}) };
  const rows = fields.after('message', 'recorded_at', since, ['app', 'conversation_id', 'speaker', 'final_reply', 'at', 'authored_at'], { limit: settings.scan, ...(sinceId ? { after_id: sinceId } : {}) });
  const { ends, open } = turnEnds(rows, { now: at, quietMs: settings.quiet_minutes * MINUTE_MS, aiSpeakers: settings.ai_speakers });
  // The exact last decided pair is the place, including within one ingestion timestamp.
  // A batch may contain more than a classification/page limit at that same instant.
  // Rewinding the entire tied group reweighed its first six forever; advancing only
  // the timestamp instead would omit the unvisited remainder. Legacy scalar places
  // still start strictly after their timestamp until a new pair is kept.
  const placeOf = row => ({ through: row.recorded_at, through_id: row.id });
  const placeBefore = index => index > 0 ? placeOf(rows[index - 1]) : incomingPlace;
  let place = open < rows.length ? placeBefore(open) : rows.length ? placeOf(rows[rows.length - 1]) : incomingPlace;
  let waiting = false;
  let waitingAt = -1;
  // The first message left undecided by this run, and when it can be decided.
  let openEnd = open < rows.length ? { index: open, at: Date.parse(rows[open].recorded_at) + settings.quiet_minutes * MINUTE_MS } : null;
  if (!openEnd && rows.length >= settings.scan) openEnd = { index: rows.length - 1, at };
  const weighed = [];
  let silentUntil = kept?.silent_until ?? null;
  let weighedEnds = 0;
  for (const index of ends) {
    const row = rows[index];
    // A completed reply is weighed by its own run (the reply road), so the sweep never asks about it twice, and it does
    // not use up the run's count: a backlog of them made a run of its own for every most_per_run replies.
    if (row.final_reply === true) continue;
    if (weighedEnds === settings.most_per_run) { place = placeBefore(index); openEnd = { index, at }; break; }
    weighedEnds += 1;
    const one = await weighOne(row);
    if (one.waiting) {
      place = placeBefore(index); waiting = true; waitingAt = index;
      if (!one.silent) silentUntil = retryOf('', row, at).at;
      break;
    }
    if (one.done) { weighed.push(one.done); silentUntil = null; }
  }
  // The place is kept only when it moved or a turn was weighed: a sweep that found nothing new rewrote the same place
  // with a new time after every AI reply (2026-10-08, the store's rows written). It is kept on top of what is kept now,
  // so the replies waiting there (written by their own runs while this one asked) are not lost.
  if (weighed.length || place.through !== (kept?.through ?? null) || (place.through_id ?? null) !== (kept?.through_id ?? null) || silentUntil !== (kept?.silent_until ?? null)) {
    const latest = keptNow();
    // Direct reply runs preserve this place while merging their waiting queue.
    // An independently advanced place must never be taken back by an older await.
    const newer = latest?.through && (latest.through > place.through || latest.through === place.through &&
      (!latest.through_id || place.through_id && latest.through_id > place.through_id));
    if (newer) place = { through: latest.through, ...(latest.through_id ? { through_id: latest.through_id } : {}) };
    const { through_id: _priorId, ...latestWithoutId } = latest ?? {};
    keep({ ...latestWithoutId, ...place, at: new Date(at).toISOString(), last: [...weighed, ...(latest?.last ?? [])].slice(0, settings.kept), silent_until: silentUntil });
  }
  const left = weighed.filter(item => item.verdict === 'leaves-a-step').length;
  const counted = { count: weighed.length, turns: weighed.length === 1 ? settings.words.turn : settings.words.turns, left };
  // A turn end the computer did not answer is asked again at the next try on its ladder; one still open, at its quiet
  // time (or at once when this run stopped at its page or count). Each key carries its time (invariant 6).
  const opened = openEnd && new Date(Math.max(openEnd.at, at)).toISOString();
  const again = waiting ? retryOf('steps-ais-leave-retry', rows[waitingAt], at, Date.parse(silentUntil ?? '') || 0)
    : openEnd ? { at: opened, key: `steps-ais-leave-again:${rows[openEnd.index].id}:${opened}` } : null;
  const said = waiting ? fill(settings.words.no_classifier, counted) : weighed.length ? fill(settings.words.weighed, counted) : settings.words.nothing;
  return { weighed, through: place.through, said, again, read: rows.length, newest_read: rows.length ? rows[rows.length - 1].recorded_at ?? null : null };
}
