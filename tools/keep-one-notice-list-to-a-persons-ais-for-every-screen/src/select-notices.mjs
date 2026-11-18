// src/select-notices.mjs
//
// PURPOSE
//   Which notices one reader is shown now, and the claim that spends its cursor. Values in, values out: the caller reads the
//   notices and the reader's cursor from the person's store, and writes the claim back (workflow:keep-one-notice-list-to-a-persons-ais).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here reads or writes a store; the notices, the cursor, the clock and the rules are arguments.
//   2. A reader is never shown a notice it made itself, nor a notice addressed to another reader.
//   3. A reader seen for the first time gets only the notices of the first-look window, at most most_at_once, the newest ones;
//      an addressed notice is never crowded out by the notices every reader is shown.
//   4. The claim names the cursor it was read at (from) and the seq it spends up to (upto); the store moves the cursor only
//      when it still holds from, so one claim wins and a second one from the same value is refused.

/**
 * notices: [{ seq, at (ISO time), from_reader, for_reader }] in seq order; cursor: { seq } or null; now: ms; rules:
 * { first_look_hours, most_at_once }. Returns { notices, claim } where claim is null when there is nothing to show.
 */
export function unseenFor({ notices, cursor = null, reader, now, rules }) {
  const last = notices.length ? notices[notices.length - 1].seq : null;
  if (last === null || (cursor && cursor.seq >= last)) return { notices: [], claim: null };
  const mine = notice => notice.for_reader === reader;
  const forThisReader = notices.filter(notice => (!notice.for_reader || mine(notice)) && notice.from_reader !== reader);
  const waiting = cursor
    ? forThisReader.filter(notice => notice.seq > cursor.seq)
    : forThisReader.filter(notice => mine(notice) || now - Date.parse(notice.at) <= rules.first_look_hours * 3_600_000);
  if (!waiting.length) return { notices: [], claim: null };
  const addressed = waiting.filter(mine);
  const everyone = waiting.filter(notice => !mine(notice));
  const room = Math.max(0, rules.most_at_once - addressed.length);
  const ordinary = cursor ? everyone.slice(0, room) : everyone.slice(Math.max(everyone.length - room, 0));
  const shown = [...addressed, ...ordinary].sort((a, b) => a.seq - b.seq);
  const shownSeqs = new Set(shown.map(notice => notice.seq));
  const omitted = cursor ? waiting.find(notice => !shownSeqs.has(notice.seq)) : null;
  const upto = omitted ? omitted.seq - 1 : last;
  return { notices: shown, claim: { reader, from: cursor ? cursor.seq : null, upto, shown: shown.map(notice => notice.seq) } };
}
