// Source-first port; configuration is supplied by authenticated list rows.

export function createHQSharing(record) {
// src/hq-sharing.mjs
//
// PURPOSE
//   What Trillion HQ (the operator account) may see about one account: `activity` (what the person did) and `content`
//   (what they wrote), kept in APP_KV as `hq-sharing:<accountId>` = { activity, content, set_at, via }. The words that
//   say so at sign-up and in Settings, and the defaults, are records/hq-sharing.json. src/journey.mjs asks here before it
//   keeps anything.
//
// NON-NEGOTIABLE INVARIANTS
//   1. `activity` is ON and `content` is OFF unless the person chose otherwise. An account with no key (made before this
//      existed) reads as the default with `via: 'default'`, so it is counted until it chooses; the choice is never
//      guessed from anything else.
//   2. Only the account's own sign-in changes its own choice (the settings route passes its own user id); nothing here
//      takes another account's id from a request.
//   3. Turning `activity` off removes what HQ kept about that account (src/journey.mjs forgetJourney), not only future
//      events. `content` can never be on while `activity` is off: turning activity off turns content off too.
//   4. A key that cannot be read counts as OFF for `content` and as the default for `activity`; a storage fault never
//      widens what HQ sees beyond the default.
//   5. Each read uses the live authorized records door. Turning activity off awaits journey erasure and surfaces a failure.
//

const HQ_SHARING = record;
const HQ_SHARING_WORDS = record.words;
const keyOf = account => `${record.key_prefix}${account}`;
// Reads use the live scoped door; no cross-run consent cache.
const forgetRemembered = () => {};
const flag = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

// Preserve the source storage operations over the current authorized records owner.
// Each binding lasts one operation; its snapshot is used only for that operation's conditional write.
const boundStorage = Symbol('sharing storage');
function withStorage(env, previous) {
  if (env?.[boundStorage]) return env;
  const door = env?.sharingDoor;
  return { ...env, [boundStorage]: true, APP_KV: door ? {
    get: async key => (previous === undefined ? await door.readRecord('hq-sharing', key) : previous)?.value ?? null,
    put: async (key, value) => door.write([{ id: key, type: 'hq-sharing', value: JSON.parse(value), expected: previous ?? null }]),
  } : undefined };
}

/** The choice as stored, made safe: both flags are booleans, `content` needs `activity`. */
function shaped(value, via) {
  const activity = flag(value?.activity, record.default.activity);
  return { activity, content: activity && flag(value?.content, record.default.content), set_at: typeof value?.set_at === 'string' ? value.set_at : null, via: typeof value?.via === 'string' ? value.via : via };
}

/** What HQ may see of an account: { activity, content, set_at, via }. No key reads as the default. */
async function readSharing(env, account) {
  env = withStorage(env);
  if (!account || !env?.APP_KV) return shaped(null, 'default');
  // Always read the live scoped door, never a choice cached across doors.
  try {
    const kept = await env.APP_KV.get(keyOf(account), 'json');
    const choice = shaped(kept, 'default');

    return choice;
  } catch (error) {
    console.error('hq sharing unreadable:', String(error?.message ?? error));
    return shaped(null, 'default');
  }
}

/** Keeps an account's choice. `patch` holds `activity` and/or `content`; what it leaves out stays as it was. Returns the
 *  choice kept. */
async function writeSharing(env, account, patch, via = 'settings', now = new Date()) {
  if (!account || account !== env.account) throw new Error('Only the signed-in account changes its sharing choice.');
  const previous = await env.sharingDoor.readRecord('hq-sharing', keyOf(account));
  env = withStorage(env, previous);
  const before = await readSharing(env, account);
  const activity = flag(patch?.activity, before.activity);
  const kept = { activity, content: activity && flag(patch?.content, before.content), set_at: now.toISOString(), via };
  await env.APP_KV.put(keyOf(account), JSON.stringify(kept));

  if (!activity) await env.forgetJourney(account, { required: true });
  return { ...kept, activity_was: before.activity };
}

/** The default written when an account is made, so the choice is on record from the first day. */
async function writeDefaultSharing(env, account, now = new Date()) {
  if (!account || account !== env.account) throw new Error('Only the signed-in account sets its sharing choice.');
  const previous = await env.sharingDoor.readRecord('hq-sharing', keyOf(account));
  if (previous) return;
  env = withStorage(env, previous);
  const kept = { ...record.default, set_at: now.toISOString(), via: 'sign_up' };
  await env.APP_KV.put(keyOf(account), JSON.stringify(kept));

}

/** The keys an account's deletion must remove. */
const sharingKeys = account => [keyOf(account)];

return { HQ_SHARING, HQ_SHARING_WORDS, forgetRemembered, readSharing, writeSharing, writeDefaultSharing, sharingKeys };
}
