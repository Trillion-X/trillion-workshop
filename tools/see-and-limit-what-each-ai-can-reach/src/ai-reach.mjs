// src/ai-reach.mjs
//
// PURPOSE
//   What each of a person's AIs may reach now, and how the person changes it after the AI connected. Every AI signs
//   in one of two ways: an app connected through the consent page (an OAuth grant) or a personal key. Each sign-in
//   carries, in its unforgeable props (src/reach.mjs), the reach it was made with and its ceiling: the reach of the
//   credential that approved it. The person may later choose another reach for it on Account & security or by adding
//   it to a space; that choice is kept in the person's own store (one EEAF record per sign-in, `sign-in-reach:<sign-in
//   id>`, type `sign-in-reach`; `signInReachCarrier` carried the earlier `sign_in_reach` table) and applies on
//   the sign-in's next request, because the Worker asks the store for it on every request (PersonStore.signInReach).
//
// NON-NEGOTIABLE INVARIANTS
//   1. A chosen reach applies only while it is within the sign-in's ceiling, checked where it is applied (currentReach)
//      as well as where it is chosen (choicesFor), so nothing written in the store can widen a sign-in past what the
//      credential that approved it reached.
//   2. The ceiling comes from the sign-in's own props or grant record, never from a browser or an AI: an AI cannot
//      change its own reach, only the signed-in person on their own pages can.
//   3. A sign-in whose reach this service cannot read yet (an app connected before reaches were recorded, not used
//      since) is shown as not known and cannot be changed until its next request records it.
//   4. Reaches are the one shape of src/reach.mjs ({ private, spaces: "all" | [ids] }); words about them come from
//      src/ai-reach-words.json, choices from src/reach-choices.json followed by its `more_choices`.
//
// KEY CONCEPTS
//   sign-in id: `grant:<grant id>` for an app's sign-in (the provider's tokens are `<user>:<grant>:<secret>`), or
//   `key:<key hash>` for a personal key. AI id: `app:<the app's name>` (all sign-ins of one app together; its first grant id when it gave no name) or `key:<hash>`.
//
import { FULL_REACH, REACH_CHOICES, isFull, reachFrom, reachOfProps, within } from '../../limit-what-one-sign-in-may-reach-the-persons/src/reach.mjs';
import words from './ai-reach-words.json' with { type: 'json' };
import { checkCarried } from '../../recently-deleted-and-storage/carry-tables-into-records.mjs';

export const AI_REACH_WORDS = words;
/** Every choice a person can make for an AI after it connected, in order: the consent page's, then the rest. */
export const AI_REACH_CHOICES = [...REACH_CHOICES, ...words.more_choices];

export const grantSignIn = grantId => `grant:${grantId}`;
export const keySignIn = keyId => `key:${keyId}`;
/** A browser's sign-in, by its session's hash (the id Account & security lists it under). */
export const sessionSignIn = sessionId => `session:${sessionId}`;

/** The sign-in a /mcp request came with, or null: its personal key, else its app grant (named in the bearer token). */
export function signInOfRequest(props, request) {
  if (typeof props?.key_id === 'string' && props.key_id) return keySignIn(props.key_id);
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const [user, grant] = token.split(':');
  return user && grant && user === props?.userId ? grantSignIn(grant) : null;
}

/** How a sign-in's approval was proven (src/sign-in-lifetimes.json), from its props: an app's records it; a personal key is `key`. */
export const approvedByOfProps = props => (typeof props?.approved_by === 'string' ? props.approved_by : props?.key_id ? 'key' : null);
/** The furthest a sign-in may be given, from its props: the credential that approved it, else its own reach. */
export const ceilingOfProps = props => (props?.ceiling ? reachFrom(props.ceiling) : reachOfProps(props));
/** The props (and grant record fields) that keep a sign-in's ceiling: none when it already reaches everything. */
export const ceilingProps = (reach, held) => (isFull(reach) ? {} : { ceiling: held });

// The claims each issuer builds from the credential it verified, one shape per kind of sign-in. A vouch the issuer
// holds for exactly these claims (src/sign-in-vouch.mjs) goes with them as sign_in_vouch.
const withVouch = vouch => (typeof vouch === 'string' && vouch ? { sign_in_vouch: vouch } : {});
/** A browser session's claims, from its verified cookie's saved session: everything, unless the session names less. */
export const browserSessionClaims = session => ({ issued_at: session.issued_at ?? session.created_at, sign_in: sessionSignIn(session.id),
  made: reachOfProps(session), ceiling: ceilingOfProps(session), approved_by: session.method ?? null, browser_generation: session.browser_generation ?? 0,
  ...withVouch(session.sign_in_vouch) });
/** Whether a saved browser session may bind its account's owner: its user's own sign-in, never a look (a viewer's view-as or
 *  a screen picture's) and never a throwaway showcase sign-in. The account's own personal key binds
 *  through its own road (src/account-owner-binding.mjs bindKeyOwnerOnce), never through a session. */
export const sessionBindsOwner = saved => Boolean(saved && typeof saved.userId === 'string' && saved.userId && !saved.look_only && !saved.viewer && !saved.grant && !saved.throwaway);
const LOOK_REACH = Object.freeze({ private: true, spaces: [] });
/** A view-as look's claims (src/view-as.mjs): its own reach only, approved by the look and bound to its grant; `asked`
 *  ({ method, path }) binds them to the one read it asks (src/native-look-authorization.mjs assertNativeLookBinding). */
export const lookSessionClaims = (session, asked = null) => {
  const sign_in = sessionSignIn(session.id);
  const look = { grant: session.look_grant, viewer: session.viewer, issued_at: session.created_at, browser_generation: session.browser_generation,
    expires_at: session.look_until, sign_in, ...(asked ? { method: asked.method, path: asked.path } : {}) };
  return { issued_at: session.created_at, sign_in, made: LOOK_REACH, ceiling: LOOK_REACH, approved_by: 'view-as',
    browser_generation: session.browser_generation ?? 0, look, ...withVouch(session.sign_in_vouch) };
};
/** An AI key's or grant's claims, from the props its OAuth provider verified with its bearer. */
export const propsClaims = (props, signIn, vouch = null) => ({ issued_at: props.issuedAt ?? null, sign_in: signIn, made: reachOfProps(props),
  ceiling: ceilingOfProps(props), approved_by: approvedByOfProps(props), ...withVouch(vouch) });
/** A personal key's claims, from its saved record found by the key's own hash; `approved_by` names the road it came on. */
export const personalKeyClaims = (saved, hash, approved_by, vouch = null) => ({ issued_at: saved.created_at, sign_in: keySignIn(hash),
  made: reachOfProps(saved), ceiling: ceilingOfProps(saved), approved_by, ...withVouch(vouch) });

/** The sign-in's claims (issued_at, sign_in, made, ceiling, approved_by) the Worker sends with a call it forwards on a
 *  kept acceptance; the store checks them in the same trip (PersonStore admitClaims). Set only by the Worker. */
export const CLAIMS_HEADER = 'x-trillion-sign-in-claims';
/** Set on the store's answer when it refused those claims (the sign-in ended or its reach changed since). */
export const CLAIMS_REFUSED_HEADER = 'x-trillion-claims-refused';

/** Refuse a disconnected sign-in before its reach is read or first recorded. */
export async function authorizeSignIn({ accepts, reachFor }, issuedAt, signIn, made, ceiling) {
  if (!(await accepts(issuedAt))) return { accepted: false, reach: null };
  return { accepted: true, reach: signIn ? await reachFor(signIn, made, ceiling) : made };
}

/** The reach a sign-in has now: the one chosen for it when that is still within its ceiling, else the one it was
 *  made with; null when what it was made with is not known. */
export function currentReach({ made, ceiling, chosen }) {
  if (!made) return null;
  return chosen && ceiling && within(chosen, ceiling) ? chosen : made;
}

const sameReach = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const choiceRow = id => AI_REACH_CHOICES.find(row => row.id === id);

/** Which choice a reach is. */
export function choiceOf(reach) {
  const picked = Array.isArray(reach.spaces);
  return AI_REACH_CHOICES.find(row => row.private === reach.private
    && (row.spaces === 'all' ? reach.spaces === 'all' : row.spaces === 'picked' ? picked && reach.spaces.length > 0 : picked && !reach.spaces.length))?.id ?? null;
}

/** The reach a choice makes, with the spaces picked when the choice picks them. */
export function reachOfChoice(id, spaces = []) {
  const row = choiceRow(id);
  if (!row) throw new Error('Choose what it can reach.');
  if (row.spaces === 'picked' && !(Array.isArray(spaces) && spaces.length)) throw new Error('Pick at least one pursuit.');
  return reachFrom({ private: row.private, spaces: row.spaces === 'picked' ? spaces : row.spaces });
}

/** A reach with one more space in it (unchanged when it already reaches every space). */
export const withSpace = (reach, spaceId) => (reach.spaces === 'all' || reach.spaces.includes(spaceId) ? reach : reachFrom({ private: reach.private, spaces: [...reach.spaces, spaceId] }));
export const reachesSpace = (reach, spaceId) => Boolean(reach) && (reach.spaces === 'all' || reach.spaces.includes(spaceId));

/** A reach in plain words, naming each space by its title (`titleOf(space id)`, null for a space the person left). */
export function reachWords(reach, titleOf = () => null) {
  if (!reach) return words.reads.unknown;
  if (reach.spaces === 'all') return reach.private ? words.reads.everything : words.reads.every_space;
  if (!reach.spaces.length) return words.reads.private_only;
  const names = [...new Set(reach.spaces.map(id => titleOf(id) ?? words.reads.left_space))];
  const listed = names.length > 1 ? `${names.slice(0, -1).join(words.joiner)}${words.last_joiner}${names.at(-1)}` : names[0];
  return (reach.private ? words.reads.private_and_spaces : words.reads.spaces_only).replace('{spaces}', listed);
}

/**
 * The person's AIs with what each reaches now. `apps` are src/account-routes.mjs appsFrom rows (one per app, with its
 * grant_ids), `grants` the provider's grant summaries (whose metadata keeps the reach and ceiling each was approved
 * with), `keys` the personal key list entries, `reaches` the store's sign_in_reach rows by sign-in id. Each app and
 * key comes back as it was, plus { ai_id, sign_ins: [{ sign_in, made, ceiling, chosen }], reach, differs }.
 */
export function withReaches({ apps, grants, keys, reaches }) {
  const grantById = new Map(grants.map(grant => [grant.id, grant]));
  const known = value => (value ? reachFrom(value) : null);
  const state = (signIn, made, ceiling) => {
    const kept = reaches[signIn] ?? {};
    const madeNow = kept.made ?? made;
    return { sign_in: signIn, made: madeNow, ceiling: kept.ceiling ?? ceiling ?? madeNow, chosen: kept.chosen ?? null };
  };
  const summed = signIns => {
    const now = signIns.map(currentReach);
    const unknown = now.some(reach => !reach);
    const differs = !unknown && now.some(reach => !sameReach(reach, now[0]));
    return { sign_ins: signIns, reach: unknown || differs ? null : now[0], differs };
  };
  return {
    apps: apps.map(app => ({ ...app, ai_id: `app:${app.name ?? app.id}`, ...summed(app.grant_ids.map(id => {
      const metadata = grantById.get(id)?.metadata ?? {};
      return state(grantSignIn(id), known(metadata.reach), known(metadata.ceiling));
    })) })),
    keys: keys.map(key => ({ ...key, ai_id: keySignIn(key.id), ...summed([state(keySignIn(key.id), key.reach ? reachFrom(key.reach) : FULL_REACH, known(key.ceiling))]) })),
  };
}

/** What to keep for each sign-in of one AI to give it `reach`: refused when any of its sign-ins is not known yet or
 *  was approved with less than `reach`. */
export function choicesFor(ai, reach) {
  if (ai.sign_ins.some(signIn => !signIn.made)) throw new Error(words.fields.unknown_note);
  if (ai.sign_ins.some(signIn => !within(reach, signIn.ceiling))) throw new Error('It was connected with less than that, so it cannot be given more here. Connect it again with your passkey to give it more.');
  return ai.sign_ins.map(signIn => ({ sign_in: signIn.sign_in, reach, made: signIn.made, ceiling: signIn.ceiling }));
}

const REACH_TYPE = 'sign-in-reach';
const reachRecordId = signIn => `${REACH_TYPE}:${signIn}`;
const kept = (eeaf, signIn) => eeaf.read(reachRecordId(signIn));
const keep = (eeaf, signIn, value) => eeaf.write([{ id: reachRecordId(signIn), type: REACH_TYPE, value }], { actor: { by: 'trillion' } });

/** The person's own store's record of each sign-in's reach: one EEAF record per sign-in ({ made, ceiling, chosen,
 *  changed_at }, `eeaf` the person's record store: read, write, ids). */
export function signInReachStore(eeaf) {
  return {
    /** Whether an earlier request has already kept this sign-in's reach. This read never registers a sign-in. */
    registered(signIn) { return Boolean(kept(eeaf, signIn)?.made); },
    /** The reach a sign-in has now; what it was made with is kept the first time it is seen, from its own props. */
    reachFor(signIn, made, ceiling) {
      let now = kept(eeaf, signIn);
      if (!now?.made) {
        now = { chosen: null, changed_at: null, ...now, made, ceiling };
        keep(eeaf, signIn, now);
      }
      // The ceiling applied is always the one the request's own props carry, whatever was kept.
      return currentReach({ made, ceiling, chosen: now.chosen ?? null });
    },
    all() {
      // Only ids this store names (another writer may use the same type for its own ids, never these).
      return Object.fromEntries(eeaf.ids(REACH_TYPE).filter(id => id.startsWith(reachRecordId(''))).map(id => [id.slice(reachRecordId('').length), eeaf.read(id)]).filter(([, value]) => value)
        .map(([signIn, value]) => [signIn, { made: value.made ?? null, ceiling: value.ceiling ?? null, chosen: value.chosen ?? null }]));
    },
    /** Keep a chosen reach for each sign-in ({ sign_in, reach, made, ceiling }), refusing one past its ceiling. */
    choose(choices) {
      const at = new Date().toISOString();
      const chosen = choices.map(({ sign_in: signIn, reach, made, ceiling }) => {
        const narrowed = reachFrom(reach);
        if (!within(narrowed, reachFrom(ceiling))) throw new Error('That reaches further than it was allowed when it connected.');
        return { signIn, made: reachFrom(made), ceiling: reachFrom(ceiling), chosen: narrowed };
      });
      eeaf.write(chosen.map(({ signIn, made, ceiling, chosen: reach }) => {
        const now = kept(eeaf, signIn);
        return { id: reachRecordId(signIn), type: REACH_TYPE, value: { made: now?.made ?? made, ceiling: now?.ceiling ?? ceiling, chosen: reach, changed_at: at } };
      }), { actor: { by: 'trillion' } });
      return { chosen: choices.length, at };
    },
  };
}

/** The reaches from before they were records (the `sign_in_reach` table, reaches kept as JSON text), carried once into
 *  one record per sign-in (src/carry-tables-into-records.mjs); a sign-in already kept as a record stays as it is. */
export const signInReachCarrier = eeaf => ({
  table: 'sign_in_reach',
  carry(rows) {
    const parse = text => (text ? JSON.parse(text) : null);
    const records = rows.filter(row => !kept(eeaf, row.sign_in)).map(row => ({ id: reachRecordId(row.sign_in), type: REACH_TYPE,
      value: { made: parse(row.made), ceiling: parse(row.ceiling), chosen: parse(row.chosen), changed_at: row.changed_at ?? null } }));
    if (!records.length) return;
    eeaf.write(records, { actor: { by: 'trillion' } });
    checkCarried('sign_in_reach', records.map(record => record.value), records.map(record => eeaf.read(record.id)));
  },
});
