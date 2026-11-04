// src/brought-in.mjs
//
// Whether a record is history brought in (an earlier chat imported, a transcript read back, a backfill) or something
// happening now. One fact decides it for every kind of record: how long after its words were authored Trillion kept
// it. A record that names both times (authored_at, else at; and recorded_at) and was kept at least
// `history_after_minutes` (src/brought-in.json) after it was authored is brought in. A record that does not name both
// is treated as happening now, never guessed at.
//
// Why it exists: on 2026-10-07 a backfill of old Claude Code transcripts recorded messages from September, and the
// person's rule "turn each message you write into content drafts" opened 541 content jobs in 75 minutes for words said
// weeks earlier, each with its deliveries and workflow rows. Rules (src/automations.mjs), attention and the weigher
// (src/steps-ais-leave.mjs) act on what happens now; history brought in is kept, searchable and read, and fires none
// of them.
//
//   wordsAgeMinutes(record) -> minutes from authored to kept, or null when the record does not name both
//   broughtIn(record)       -> true when that age is at least history_after_minutes
//
// Invariants:
//   - One owner of the rule for every consumer; nobody re-derives it from their own fields.
//   - Unknown stays unknown: a missing or unreadable time is never brought in.

import settings from '../../shared-code/src/brought-in.json' with { type: 'json' };

const authoredOf = record => record?.authored_at ?? record?.at ?? null;

export function wordsAgeMinutes(record) {
  const authored = Date.parse(authoredOf(record) ?? '');
  const kept = Date.parse(record?.recorded_at ?? '');
  if (Number.isNaN(authored) || Number.isNaN(kept)) return null;
  return (kept - authored) / 60_000;
}

export const broughtIn = record => {
  const age = wordsAgeMinutes(record);
  return age !== null && age >= settings.history_after_minutes;
};
