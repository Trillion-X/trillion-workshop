// Source-first port; configuration is supplied by authenticated list rows.

export function createHQSharing(record) {
// src/hq-sharing.mjs
//
// PURPOSE
//   What Trillion HQ (the operator account) may see about one account: `activity` (what the person did) and `content`
//   (what they wrote). The words that say so at sign-up and in Settings, and the defaults, are records/hq-sharing.json.
//   This module decides values only: it reads the choice the store holds for an account, and says what the store must
//   keep next. The store keeps it under `key` (rule a-tool-is-only-what-the-store-cannot-do; recipe
//   workflow:keep-customer-journeys-and-their-choices).
//
// NON-NEGOTIABLE INVARIANTS
//   1. `activity` is ON and `content` is OFF unless the person chose otherwise. An account with no kept choice reads as
//      the default with `via: 'default'`, so it is counted until it chooses; the choice is never guessed from anything else.
//   2. Only the account's own sign-in changes its own choice (the settings route passes its own user id); nothing here
//      takes another account's id from a request.
//   3. Turning `activity` off asks for the journey rows about that account to be removed (`erase`), not only future
//      events. `content` can never be on while `activity` is off: turning activity off turns content off too.
//   4. A kept choice that cannot be read counts as OFF for `content` and as the default for `activity`; a storage fault
//      never widens what HQ sees beyond the default.
//   5. The caller compares the choice it read with what it writes, so a change made since the read is refused there.
//

const HQ_SHARING = record;
const HQ_SHARING_WORDS = record.words;
const keyOf = account => `${record.key_prefix}${account}`;
const flag = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

/** The choice as kept, made safe: both flags are booleans, `content` needs `activity`. */
function shaped(value, via) {
  const activity = flag(value?.activity, record.default.activity);
  return { activity, content: activity && flag(value?.content, record.default.content), set_at: typeof value?.set_at === 'string' ? value.set_at : null, via: typeof value?.via === 'string' ? value.via : via };
}

/** What HQ may see of an account, from the choice the store kept for it (`kept` is null when none was kept). */
const sharingOf = kept => shaped(kept, 'default');

/**
 * The choice to keep after a change. `kept` is the choice the store holds for the account now (null when none). `patch`
 * holds `activity` and/or `content`; what it leaves out stays as it was. → { key, value, activity_was, erase }: the caller
 * keeps `value` under `key` only if the stored choice is still `kept`, and when `erase` is true it removes that account's
 * journey rows and reports a failure as a failure.
 */
function sharingChange({ account, signedIn, kept, patch, via = 'settings', now = new Date() }) {
  if (!account || account !== signedIn) throw new Error('Only the signed-in account changes its sharing choice.');
  const before = sharingOf(kept);
  const activity = flag(patch?.activity, before.activity);
  const value = { activity, content: activity && flag(patch?.content, before.content), set_at: now.toISOString(), via };
  return { key: keyOf(account), value, activity_was: before.activity, erase: !activity };
}

/** The default kept when an account is made, so the choice is on record from the first day. Null when one is kept already. */
function defaultSharing({ account, signedIn, kept, now = new Date() }) {
  if (!account || account !== signedIn) throw new Error('Only the signed-in account sets its sharing choice.');
  if (kept) return null;
  return { key: keyOf(account), value: { ...record.default, set_at: now.toISOString(), via: 'sign_up' } };
}

/** The keys an account's deletion must remove. */
const sharingKeys = account => [keyOf(account)];

return { HQ_SHARING, HQ_SHARING_WORDS, sharingOf, sharingChange, defaultSharing, sharingKeys };
}
