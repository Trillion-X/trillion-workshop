// tools/check-every-screen-at-every-width/held-session.mjs
//
// PURPOSE
//   The signed-in live check's session: a proof account's cookies, held in the vault as one value (proof-sessions) and mounted by
//   the signed-in row on a descriptor. The value is JSON keyed by origin, { "https://app.gettrillion.ai": [cookie, ...], ... };
//   a page signs in with the cookies of its own origin. The value is minted and refreshed by its owner's workflow, never here.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The value is read only from the descriptor the row mounts (fd 4). It is never in an input, argv, the environment, a file,
//      a log or an answer, so no step answer can carry a cookie.
//   2. A refusal names the origin and what is missing, never a cookie's name or value.
//   3. A page gets only its own origin's cookies; a page with no entry is refused, never opened signed out as if it were in.
//
// SHAPE
//   readHeldSessions({ fd? }) -> Map(origin -> [cookie])   (cookie: { name, value, domain?, path?, secure?, httpOnly?, expires? })
//   sessionFor(sessions, url) -> [cookie]
//   heldSessionExpiries({}, host) -> { origins: [{ origin, expires_at, days_left, cookies: [{ name, expires_at }] }] }   (times only; the refresh workflow reads it)
import { createReadStream } from 'node:fs';

export const HELD = Object.freeze({ descriptor: 4, limit: 65536 });

function refuse(code, message) {
  return Object.assign(new Error(message), { code });
}

// The mounted value, read whole (the engine writes the mount once and closes it) and checked; the text is dropped after parsing.
export async function readHeldSessions({ fd = HELD.descriptor } = {}) {
  let text = '';
  try {
    for await (const bytes of createReadStream(null, { fd, autoClose: false })) {
      text += bytes;
      if (text.length > HELD.limit) throw new Error('too long');
    }
  } catch {
    throw refuse('no_held_session', `No proof session is mounted on descriptor ${fd} (the signed-in row names proof-sessions).`);
  }
  let value;
  try { value = JSON.parse(text); } catch { throw refuse('no_held_session', 'The mounted proof session is not JSON keyed by origin.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw refuse('no_held_session', 'The mounted proof session is not JSON keyed by origin.');
  const sessions = new Map();
  for (const [origin, cookies] of Object.entries(value)) {
    let parsed;
    try { parsed = new URL(origin); } catch { throw refuse('no_held_session', 'A proof session key is not an origin.'); }
    if (parsed.origin !== origin) throw refuse('no_held_session', `A proof session key is not an origin: use ${parsed.origin}.`);
    const fine = Array.isArray(cookies) && cookies.length > 0 && cookies.every(cookie => cookie && typeof cookie.name === 'string' && cookie.name && typeof cookie.value === 'string');
    if (!fine) throw refuse('no_held_session', `The proof session for ${origin} is not a list of cookies with a name and a value.`);
    sessions.set(origin, cookies);
  }
  return sessions;
}

export function sessionFor(sessions, url) {
  const { origin } = new URL(url);
  const cookies = sessions.get(origin);
  if (!cookies) throw refuse('no_held_session', `The proof session holds no sign-in for ${origin}.`);
  return cookies;
}

// When each origin's sign-in ends: the latest expires of its cookies (Playwright's seconds). The session cookie outlives the
// short cache cookies the server issues again on every visit (better-auth.session_data lasts 5 minutes), so the latest end is the
// session's. A cookie with no expires, or -1, ends with the browser and counts as no end. Answers each cookie's name and end, and
// never a value, so the refresh workflow can mint the session again in time.
export async function heldSessionExpiries(input = {}, host, { readHeld = readHeldSessions, now = Date.now() } = {}) {
  const sessions = await readHeld();
  const origins = [...sessions].map(([origin, cookies]) => {
    const endOf = cookie => (Number.isFinite(cookie.expires) && cookie.expires > 0 ? cookie.expires * 1000 : null);
    const ends = cookies.map(endOf).filter(at => at !== null);
    const named = cookies.map(cookie => ({ name: cookie.name, expires_at: endOf(cookie) === null ? null : new Date(endOf(cookie)).toISOString() }));
    if (ends.length === 0) return { origin, expires_at: null, days_left: null, cookies: named };
    const at = Math.max(...ends);
    return { origin, expires_at: new Date(at).toISOString(), days_left: Math.floor(((at - now) / 86400000) * 10) / 10, cookies: named };
  });
  return { origins };
}
