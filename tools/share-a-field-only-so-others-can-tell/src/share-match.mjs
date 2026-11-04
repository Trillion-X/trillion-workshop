// src/share-match.mjs
//
// PURPOSE
//   A field a person shares "to match only" leaves their Trillion as a keyed BLAKE3 of its value, never the value:
//   the people it is shared with can tell two shared copies hold the same value (the same email, the same address,
//   the same order number) and can ask whether a value they already know is the one shared, without being shown it.
//   This is a blind index: the key lives only in the service (the Worker secret SHARE_MATCH_KEY), so nobody holding a
//   copy can work out matches for guesses by themselves; they ask match_shared_value, one value at a time, at the
//   pace their sign-in's calls a minute allow (src/sign-in-calls.json).
//
// NON-NEGOTIABLE INVARIANTS
//   1. One key for the whole service, never rotated: a value matched today matches the same value shared next year.
//      Each field derives its own key from it, so the same value in two different fields never matches.
//   2. A value is compared as people mean it: words in Unicode NFC, trimmed, spaces folded and case ignored; any other
//      value as its JSON.
//   3. No key, no copy: a share that asks for a match-only field when SHARE_MATCH_KEY is not set is refused, so a field
//      the person asked to hide is never sent as plain text instead.
//   4. The mark is `1f:` and 64 hex, the same identity form every other Trillion identity has, inside { match }.
//   5. Checking a known value against a shared copy is asked of the record's owner (src/record-sharing.mjs answerMatch),
//      never worked out from the copy: a copy carries only its mark, and the key that makes marks stays in the service.
//      Every such question is kept in the owner's match_asks, which nothing can change or remove (matchAsks), so the
//      owner sees who tried which field, when, where, and whether it matched.
//
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { secret } from './worker-secrets.mjs';

const encoder = new TextEncoder();
const CONTEXT = encoder.encode('trillion shared field match');

/** A value as it is compared (invariant 2). */
export function matchForm(value) {
  if (typeof value === 'string') return value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
  return JSON.stringify(value ?? null);
}

/**
 * The function that marks a value of a field to match only: (field, value) -> { match: '1f:<hex>' }. Throws when the
 * service holds no SHARE_MATCH_KEY (invariant 3).
 */
export function shareMatcher(env) {
  const key = secret(env, 'SHARE_MATCH_KEY');
  if (!key) return () => { throw new Error('Sharing a field to match only is not set up on this service yet, so it was not shared.'); };
  const root = blake3(hexToBytes(key), { context: CONTEXT });
  const keys = new Map();
  return (field, value) => {
    if (!keys.has(field)) keys.set(field, blake3(encoder.encode(field), { key: root }));
    return { match: `1f:${bytesToHex(blake3(encoder.encode(matchForm(value)), { key: keys.get(field) }))}` };
  };
}

/** The owner's record of every value checked against their match-only fields: kept, never changed or removed. */
export function matchAsks(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS match_asks (at TEXT NOT NULL, record TEXT NOT NULL, field TEXT NOT NULL, asker TEXT NOT NULL, asker_relay TEXT, place TEXT NOT NULL, matched INTEGER NOT NULL)');
  sql.exec('CREATE INDEX IF NOT EXISTS match_asks_record ON match_asks (record, at)');
  for (const event of ['UPDATE', 'DELETE']) {
    sql.exec(`CREATE TRIGGER IF NOT EXISTS match_asks_kept_${event.toLowerCase()} BEFORE ${event} ON match_asks BEGIN SELECT RAISE(ABORT, 'A kept question is never changed or removed.'); END`);
  }
  return {
    ask({ record, field, asker, asker_relay: askerRelay = null, place, matched }, at = new Date().toISOString()) {
      sql.exec('INSERT INTO match_asks (at, record, field, asker, asker_relay, place, matched) VALUES (?, ?, ?, ?, ?, ?, ?)', at, record, field, asker, askerRelay, place, matched ? 1 : 0);
    },
    /** The newest questions about one record, newest first. */
    of(record, limit = 50) {
      return sql.exec('SELECT at, field, asker, place, matched FROM match_asks WHERE record = ? ORDER BY at DESC LIMIT ?', record, limit).toArray()
        .map(row => ({ at: row.at, field: row.field, asker: row.asker, place: row.place, matched: row.matched === 1 }));
    },
  };
}
