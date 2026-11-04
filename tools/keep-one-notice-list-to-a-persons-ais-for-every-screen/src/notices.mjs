// src/notices.mjs
//
// Purpose
//   The one notice to a person's AIs for every screen and tool; a part that adds its own notice list repeats it. It
//   keeps what every AI working for one person has not seen yet. A person runs several AIs at once (in a coding harness, in
//   a chat app, on a phone); when one of them changes something that matters to the others, a short notice is kept
//   here, and each AI is shown every notice it has not seen, once, the next time it reaches Trillion: riding on any
//   tool reply (src/worker.mjs), or printed into its turn by a prompt hook (harness/decisions-since.mjs).
//
// Non-negotiable invariants
//   1. One list per person, one cursor per reader. A notice is kept once, in order; a reader's cursor is the last
//      sequence it was shown. Nothing is copied per reader. The list is kept one record per notice (src/kept-list.mjs),
//      so keeping a notice writes that notice, never the whole list again.
//   2. A reader sees each notice at most once, and never a notice it made itself (from_reader).
//   3. A reader seen for the first time is shown only the recent notices (first_look_hours, at most most_at_once), so
//      a new session starts from what is current, not from everything ever decided.
//   4. The same (kind, key) is one notice: deciding again with the same words adds nothing.
//   5. Reading writes only when notices newer than the reader's cursor exist; a reader whose cursor has not moved for
//      forget_reader_days is forgotten, so the store stays the same size however many readers come.
//   6. Nothing here names a kind of notice, an app or a harness: kind, key, refs and the sentence are the caller's.
//   7. A notice may be addressed (for_reader): then only that reader is ever shown it, and it waits for that reader
//      whatever its age, so an AI that sleeps for days (a chat app opened once a week) is still told on its first
//      tool reply. A notice with no addressee is for every reader, as in 1 to 3.
//   8. One sign-in can serve several programs (ChatGPT's own chats and Codex share ChatGPT's sign-in). A reader is
//      addressed by its sign-in, but each program that reaches Trillion through it (its transport, an opaque id the
//      host gives) keeps its own cursor, so work addressed to ChatGPT is not spent on a Codex call before any ChatGPT
//      chat has seen it.
//   9. A signed-in tool call asks no store call of its own for them: the sign-in check answers what the reader has not
//      seen (`peek`, nothing written), and the cursor moves (`see`) only when the tool call succeeded and the notices
//      are about to be shown. A cursor another call moved in between voids the claim, so a notice is shown once, and a
//      failed call spends nothing.
//
// Key concepts
//   reader  any text naming who reads: `app:<name>` or `key:<id>` for a signed-in sign-in, `session:<id>` for a hook.
//   notice  { seq, kind, key, at, from_reader, for_reader, refs: { name: id }, said, next_call }. Readers are shown
//           { kind, at, refs, said } and next_call ({ tool, arguments }, the call that acts on it) when it has one.
//
// Security
//   One store per person (the host's partition); nothing is read across people. Notices carry a sentence and ids,
//   never inputs, results or file bytes.
//
import settings from '../../hand-off-jobs-between-agents/src/notices.json' with { type: 'json' };
export { settings as noticeSettings };
import { alsoSay } from '../../organize-my-files/src/tool-reply.mjs';
import { keptList } from '../../keep-a-short-list/src/kept-list.mjs';
import { handoffNotice } from '../../hand-off-jobs-between-agents/src/handoff-notice.mjs';

const LIST = 'notices';
const READERS = 'notice-readers';
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export class NoticeError extends Error {}

// Who is reading, for notices: a personal key by its own id, else the connected app by its name.
export const readerOf = (props, app) => (typeof props?.key_id === 'string' && props.key_id ? `key:${props.key_id}` : app ? `app:${app}` : null);

const outward = ({ kind, at, refs, said, next_call }) => ({ kind, at, refs, said, ...(next_call ? { next_call } : {}) });

// eeaf: the person's EEAF store ({ write, read }).
export function notices(eeaf, { now = () => new Date(), rules = settings } = {}) {
  const listed = keptList(eeaf, { id: LIST, type: 'notice-list' });
  const list = () => listed.items();
  const readers = () => eeaf.read(READERS)?.readers ?? {};

  return {
    // Keeps one notice; the same kind and key is kept once. for_reader addresses it to one reader only.
    add({ kind, key, from_reader = null, for_reader = null, refs = {}, said, next_call = null } = {}) {
      if (!nonempty(kind) || !nonempty(key) || !nonempty(said)) throw new NoticeError('A notice needs kind, key and said.');
      if (!object(refs) || !Object.values(refs).every(nonempty)) throw new NoticeError('refs is { name: id }, each id as text.');
      const items = list();
      if (items.some(item => item.kind === kind && item.key === key)) return { added: false };
      const item = { seq: (items.at(-1)?.seq ?? 0) + 1, kind, key, at: now().toISOString(), from_reader: nonempty(from_reader) ? from_reader : null, for_reader: nonempty(for_reader) ? for_reader : null, refs, said: said.slice(0, rules.said_max), ...(object(next_call) && nonempty(next_call.tool) ? { next_call } : {}) };
      listed.put([...items, item].slice(-rules.keep), { actor: { by: 'trillion' } });
      return { added: true, notice: outward(item) };
    },

    // What this reader has not seen, oldest first, and the claim that spends it, with nothing written: { notices, claim }.
    // No claim means the reader has seen all there is; a claim with no notices only moves a cursor past what was not
    // for this reader.
    peek(reader, { transport = null } = {}) {
      if (!nonempty(reader)) throw new NoticeError('reader names who is reading.');
      const cursor = nonempty(transport) ? `${reader}|${transport}` : reader;
      // The newest seq is on the list's head: a reader who has seen it reads no notice at all.
      const last = listed.lastSeq();
      if (last === null) return { notices: [] };
      // An entry that only remembers what a take showed (takenAgain) is no cursor yet.
      const held = readers()[cursor];
      const mark = Number.isFinite(held?.seq) ? held : null;
      if (mark && mark.seq >= last) return { notices: [] };
      const items = list();
      const at = now();
      const mine = item => item.for_reader === reader;
      const forThisReader = items.filter(item => (!item.for_reader || mine(item)) && item.from_reader !== reader);
      const seen = mark?.seen ?? [];
      const waiting = mark ? forThisReader.filter(item => item.seq > mark.seq && !seen.includes(item.seq))
        : forThisReader.filter(item => mine(item) || at.getTime() - Date.parse(item.at) <= rules.first_look_hours * 3_600_000);
      if (!mark && !waiting.length) return { notices: [] };
      // What is addressed to this reader is never crowded out by what every reader is shown.
      const addressed = waiting.filter(mine);
      const everyone = waiting.filter(item => !mine(item));
      const room = Math.max(0, rules.most_at_once - addressed.length);
      const ordinary = mark ? everyone.slice(0, room) : everyone.slice(Math.max(everyone.length - room, 0));
      const shown = [...addressed, ...ordinary].sort((a, b) => a.seq - b.seq);
      // Established readers drain oldest ordinary notices first. Addressed notices may jump ahead, but only the
      // contiguous delivered frontier advances; those ahead of it are remembered separately until it catches up.
      const shownSeqs = new Set(shown.map(item => item.seq));
      const omitted = mark ? waiting.find(item => !shownSeqs.has(item.seq)) : null;
      const upto = omitted ? omitted.seq - 1 : last;
      const ahead = [...new Set([...seen, ...shownSeqs])].filter(seq => seq > upto).sort((a, b) => a - b);
      return { notices: shown.map(outward), claim: { reader, transport: nonempty(transport) ? transport : null, from: mark?.seq ?? null, upto, shown: shown.map(item => item.seq),
        ...(seen.length ? { from_seen: seen } : {}), ...(ahead.length ? { seen: ahead } : {}) } };
    },

    // Moves the reader's cursor past what its claim covered, and says whether it did: a cursor another call moved since
    // the claim was made is left alone and the claim is void, so what was shown is shown once.
    // `taken` (from a take): the key of the call that spent it, with the seqs it showed and the live jobs it told, so the
    // same call asked again answers the same notices (takenAgain).
    see({ reader, transport = null, from = null, from_seen = [], upto, seen = [], shown = [] } = {}, taken = null) {
      const cursor = nonempty(transport) ? `${reader}|${transport}` : reader;
      const all = readers();
      if ((Number.isFinite(all[cursor]?.seq) ? all[cursor].seq : null) !== from || JSON.stringify(all[cursor]?.seen ?? []) !== JSON.stringify(from_seen)) return false;
      const at = now();
      const cutoff = at.getTime() - rules.forget_reader_days * 86_400_000;
      const kept = Object.fromEntries(Object.entries(all).filter(([name, value]) => name !== cursor && Date.parse(value.at) >= cutoff));
      eeaf.write([{ id: READERS, type: 'notice-readers', value: { readers: { ...kept, [cursor]: { seq: upto, at: at.toISOString(), ...(seen.length ? { seen } : {}),
        ...(nonempty(taken?.by) ? { by: taken.by, shown, live: taken.live ?? [] } : {}) } } } }], { actor: { by: 'trillion' }, unwatched: true });
      return true;
    },

    // Remembers that the call keyed `by` told this reader the live jobs `live` and no kept notice (a plan that keeps
    // nothing), keeping the reader's cursor as it is.
    markTaken(reader, { transport = null, by, live = [] } = {}) {
      const cursor = nonempty(transport) ? `${reader}|${transport}` : reader;
      const all = readers();
      eeaf.write([{ id: READERS, type: 'notice-readers', value: { readers: { ...all, [cursor]: { ...(all[cursor] ?? {}), at: now().toISOString(), by, shown: [], live } } } }], { actor: { by: 'trillion' }, unwatched: true });
    },

    // What the call keyed `by` took for this reader, asked again: the same kept notices (those still kept) and the
    // handoff ids of the live jobs it told, or null when that call spent nothing.
    takenAgain(reader, { transport = null, by } = {}) {
      const cursor = nonempty(transport) ? `${reader}|${transport}` : reader;
      const entry = readers()[cursor];
      if (!nonempty(by) || entry?.by !== by) return null;
      const shown = new Set(entry.shown ?? []);
      return { notices: list().filter(item => shown.has(item.seq)).map(outward), live: entry.live ?? [] };
    },

    // Every notice this reader has not seen, oldest first, and the cursor of this reader's transport moved past them.
    unseen(reader, { transport = null } = {}) {
      const found = this.peek(reader, { transport });
      if (found.claim) this.see(found.claim);
      return found.notices;
    },
  };
}

// What a job held in memory for a reader says (src/live-work.mjs), on a plan that keeps nothing.
const liveSaid = job => handoffNotice({ moment: 'waiting_for_anyone', handoff: job }).said;
// What Trillion told the person reaches their AIs on every plan; the other kept kinds are a kept plan's.
const noticeSettingsShown = notice => settings.shown_without_a_plan.includes(notice.kind);

/**
 * The account's notice claim, the same wherever the account's notices are kept. `kept` is notices(eeaf) of that
 * account, `liveJobs` its jobs held in memory (src/live-work.mjs), `keeps` whether its plan keeps decisions.
 * peekUnseenAt: what `reader` has not seen yet and the claim that spends it, written as nothing, or null when there is
 * nothing to show. A cursor that only has to move past notices not meant for this reader moves now, as nothing shows.
 * On a plan that keeps nothing the news is a job held for this AI, plus what Trillion told the person
 * (settings.shown_without_a_plan); the other kept kinds are passed unshown.
 */
export function peekUnseenAt({ kept, liveJobs, keeps, reader, transport = null }) {
  if (!reader) return null;
  if (!keeps) {
    const found = liveJobs.unseen(reader, liveSaid, { peek: true });
    const told = kept.peek(reader, { transport });
    const shown = told.notices.filter(noticeSettingsShown);
    if (told.claim && !shown.length) kept.see(told.claim);
    const all = [...found, ...shown];
    // The kept claim names only the seqs shown (told.notices and claim.shown are in the same order).
    const keptClaim = shown.length ? { ...told.claim, shown: told.claim.shown.filter((_, index) => noticeSettingsShown(told.notices[index])) } : null;
    return all.length ? { reader, notices: all, claim: { reader, live: found.map(notice => notice.refs.handoff_id), ...(keptClaim ? { kept: keptClaim } : {}) } } : null;
  }
  const found = kept.peek(reader, { transport });
  if (found.claim && !found.notices.length) kept.see(found.claim);
  return found.notices.length ? { reader, notices: found.notices, claim: found.claim } : null;
}

/** Spends what peekUnseenAt(...).claim covered: true when this call is the one to show it, false when another spent it. */
export function seeUnseenAt({ kept, liveJobs, claim }) {
  if (!claim?.live) return kept.see(claim);
  const live = claim.live.length ? liveJobs.tell(claim.reader, claim.live) : true;
  return (claim.kept ? kept.see(claim.kept) : true) && live;
}

// What the call under `key` took for `reader`, read from the cursor it moved, or null when the cursor names another call.
function takenBy({ kept, liveJobs, reader, transport, key }) {
  const again = kept.takenAgain(reader, { transport, by: key });
  if (!again) return null;
  const live = new Set(again.live);
  const held = (liveJobs?.list?.() ?? []).filter(job => live.has(job.handoff_id)).map(job => ({ kind: 'handoff', at: job.handed_at, refs: { handoff_id: job.handoff_id }, said: liveSaid(job) }));
  return { notices: [...held, ...again.notices] };
}

/** A lost take read from the cursor it moved, never by taking again: the cursor kept under this call's key answers what
 *  it took; with no reader nothing was taken; a cursor naming another call (or none) cannot say whether this one took
 *  something before a later call moved it. */
export function takenUnseenAt({ kept, liveJobs, reader, transport = null, key = null }) {
  if (!reader) return { state: 'aborted' };
  const again = key ? takenBy({ kept, liveJobs, reader, transport, key }) : null;
  return again ? { state: 'committed', result: again } : { state: 'unknown' };
}

/** Takes what `reader` has not seen yet: peeks and spends at once, for a reply that is built save for these notices.
 *  `key` is the taking call's own key: the same call asked again answers the same notices (takenAgain) and spends
 *  nothing twice. A claim another call spent first shows nothing. */
export function takeUnseenAt({ kept, liveJobs, keeps, reader, transport = null, key = null }) {
  if (!reader) return { notices: [] };
  const again = takenBy({ kept, liveJobs, reader, transport, key });
  if (again) return again;
  const found = peekUnseenAt({ kept, liveJobs, keeps, reader, transport });
  if (!found) return { notices: [] };
  const { claim } = found;
  if (!claim.live) return { notices: kept.see(claim, key ? { by: key } : null) ? found.notices : [] };
  if (claim.live.length && !liveJobs.tell(claim.reader, claim.live)) return { notices: [] };
  const taken = key ? { by: key, live: claim.live } : null;
  if (claim.kept) return { notices: kept.see(claim.kept, taken) ? found.notices : [] };
  if (taken) kept.markTaken(reader, { transport, ...taken });
  return { notices: found.notices };
}

/** What a harness hook is told for its session (POST /notices/unseen): what it has not seen yet, taken as a reply takes
 *  it (takeUnseenAt, keyed by the hook's call), and on a plan that keeps decisions `held`, the one thing the hold holds
 *  now, so the hook can put it first in every turn. */
export function hookUnseenAt({ kept, liveJobs, keeps, reader, transport = null, key = null, held = null }) {
  const { notices } = takeUnseenAt({ kept, liveJobs, keeps, reader, transport, key });
  return { notices, ...(keeps && held ? { held } : {}) };
}

/**
 * A tool reply with what this reader has not seen yet added under settings.reply_field, or the reply as it was: only a
 * successful tools/call carries notices, so a notice is never spent on a failed call. `read(reader)` → { notices };
 * a failed read leaves the reply as it was. `afterSuccess()` may retain separate work through the host;
 * its completion is not part of the current notices claim and is never awaited here.
 */
export async function replyWithUnseen(reply, { method, reader, read, afterSuccess = null, rules = settings }) {
  if (!reader || method !== 'tools/call' || !reply?.result || reply.result.isError) return reply;
  const unseen = await Promise.resolve().then(() => {
    afterSuccess?.();
    return read(reader);
  }).then(answer => (Array.isArray(answer?.notices) ? answer.notices : []), () => []);
  return unseen.length ? alsoSay(reply, rules.reply_field, unseen) : reply;
}
