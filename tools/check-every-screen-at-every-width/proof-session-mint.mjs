// tools/check-every-screen-at-every-width/proof-session-mint.mjs
//
// PURPOSE
//   Mints the proof accounts' sessions again before they end, so the signed-in live check keeps working with no person's
//   hand. Three runs, one per step of workflow:keep-the-proof-sessions-signed-in, because a run that holds a key reaches only
//   that key's hosts: the AgentMail key reaches only the mailbox, and the sessions reach only the sites.
//     1. askForSignInCodes      (no key)                         asks each site to send its proof account a sign-in code
//     2. keepSignInCodes        (agentmail-api-key on fd 4)      reads each code from the proof inbox and puts the codes in
//                                                                the vault as proof-sign-in-code, bound to the sites
//     3. signInWithKeptCodes    (proof-sign-in-code on fd 4,     exchanges each code for its session at its site, checks the
//                                proof-sessions on fd 5)         session is the proof account's, puts the merged sessions as
//                                                                proof-sessions and marks the code value spent
//
// NON-NEGOTIABLE INVARIANTS
//   1. A code and a cookie are never in an input, an answer, a log or a file: they go from the mailbox to the vault and from the
//      vault to the site. Answers carry origins, statuses, cookie names and times only.
//   2. A code is asked only for the addresses proof-accounts.json names, so no run sends a code to anyone else.
//   3. A put names only a value that already exists, with exactly the hosts the accounts' origins name; the engine refuses a
//      run's put to any other name or to wider hosts (trillion-rust src/secrets/secret-routes.json).
//   4. A session is kept only when the site's own get-session answers the proof account's address for it.
//
// SHAPE
//   askForSignInCodes({ origins? }, host) -> { asked_at, origins: [{ origin, sent, status }] }
//   keepSignInCodes({ asked_at, origins? }, host) -> { kept: [origin], missing: [{ origin, reason }] }
//   signInWithKeptCodes({}, host) -> { origins: [{ origin, signed_in, reason?, cookies?: [{ name, expires_at }], expires_at? }] }
import { readFileSync } from 'node:fs';
import { latestSignInCode, readAgentMailKey, signInWithEmailCode } from './email-code.mjs';
import { readHeldSessions, readMounted } from './held-session.mjs';
import { openRecordsDoor } from '../records-door/read-data/records-door.mjs';

export const PROOF = JSON.parse(readFileSync(new URL('./proof-accounts.json', import.meta.url), 'utf8'));

const CODE_DESCRIPTOR = 4;
const SESSION_DESCRIPTOR = 5;
const SPENT = '{}';

function refuse(code, message) {
  return Object.assign(new Error(message), { code });
}

// The accounts a run works on: all of them, or the origins asked for, each of which must be one proof-accounts.json names.
export function accountsOf(origins, accounts = PROOF.accounts) {
  if (origins === undefined) return accounts;
  if (!Array.isArray(origins) || origins.length === 0) throw refuse('refused', 'origins is a list of the proof accounts\' origins.');
  return origins.map(origin => {
    const account = accounts.find(one => one.origin === origin);
    if (!account) throw refuse('refused', `${origin} has no proof account in proof-accounts.json.`);
    return account;
  });
}

// The hosts every put names: those of all the accounts' origins, the same hosts the values were made with.
export const hostsOf = (accounts = PROOF.accounts) => [...new Set(accounts.map(account => new URL(account.origin).hostname))].sort();

const endOf = cookie => (Number.isFinite(cookie.expires) && cookie.expires > 0 ? new Date(cookie.expires * 1000).toISOString() : null);

/** Step 1: each site sends its proof account a sign-in code. Holds no key. */
export async function askForSignInCodes(input = {}, host, { fetchImpl = fetch, now = Date.now, accounts = PROOF.accounts } = {}) {
  const chosen = accountsOf(input.origins, accounts);
  const askedAt = now();
  const origins = [];
  for (const { origin, email } of chosen) {
    const sent = await fetchImpl(`${origin}/api/auth/email-otp/send-verification-otp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ email, type: 'sign-in' }),
    }).catch(() => null);
    origins.push({ origin, sent: Boolean(sent?.ok), status: sent?.status ?? null });
  }
  if (!origins.some(one => one.sent)) throw refuse('code_not_sent', `No site sent a sign-in code (${origins.map(one => `${one.origin} ${one.status}`).join(', ')}).`);
  return { asked_at: askedAt, origins };
}

/** Step 2: the codes, read from the proof inboxes, put in the vault as the code value. Holds the AgentMail key on fd 4. */
export async function keepSignInCodes(input = {}, host, deps = {}) {
  const { readKey = readAgentMailKey, door = openRecordsDoor(), accounts = PROOF.accounts, latest = latestSignInCode } = deps;
  if (!Number.isFinite(input.asked_at)) throw refuse('refused', 'asked_at is the epoch milliseconds step 1 answered.');
  const chosen = accountsOf(input.origins, accounts);
  const apiKey = await readKey();
  const codes = {};
  const missing = [];
  for (const { origin, email } of chosen) {
    try {
      codes[origin] = { email, code: await latest({ apiKey, email, sentAt: input.asked_at }, deps) };
    } catch (error) {
      missing.push({ origin, reason: error?.code ?? 'code_not_found' });
    }
  }
  const kept = Object.keys(codes);
  if (kept.length === 0) throw refuse('code_not_found', `No sign-in code reached the proof inboxes (${missing.map(one => one.origin).join(', ')}).`);
  await door.secrets('secrets:put', { name: PROOF.code_value, value: JSON.stringify(codes), hosts: hostsOf(accounts) });
  return { kept, missing };
}

/** Step 3: each kept code exchanged for its session, checked, and the sessions put in the vault. Holds the code value on fd 4
 *  and the sessions on fd 5. */
export async function signInWithKeptCodes(input = {}, host, deps = {}) {
  const { fetchImpl = fetch, door = openRecordsDoor(), accounts = PROOF.accounts, now = Date.now } = deps;
  const { readCodes = () => readMounted(CODE_DESCRIPTOR), readSessions = () => readHeldSessions({ fd: SESSION_DESCRIPTOR }) } = deps;
  let codes;
  try { codes = JSON.parse((await readCodes()) ?? ''); } catch { throw refuse('no_codes', `No sign-in codes are mounted on descriptor ${CODE_DESCRIPTOR} (${PROOF.code_value}).`); }
  if (!codes || typeof codes !== 'object' || Object.keys(codes).length === 0) throw refuse('no_codes', `${PROOF.code_value} holds no unspent code.`);
  const sessions = await readSessions();
  const origins = [];
  for (const [origin, { email, code } = {}] of Object.entries(codes)) {
    const account = accounts.find(one => one.origin === origin && one.email === email);
    if (!account || typeof code !== 'string') { origins.push({ origin, signed_in: false, reason: 'not_a_proof_account' }); continue; }
    try {
      const cookies = await signInWithEmailCode({ origin, email, code }, { fetchImpl, at: now() });
      const header = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
      const session = await (await fetchImpl(`${origin}/api/auth/get-session`, { headers: { cookie: header, origin } })).json().catch(() => null);
      if (String(session?.user?.email ?? '').toLowerCase() !== email.toLowerCase()) throw refuse('not_the_proof_account', 'The session is not the proof account\'s.');
      sessions.set(origin, cookies);
      const ends = cookies.map(endOf).filter(Boolean).sort();
      origins.push({ origin, signed_in: true, cookies: cookies.map(cookie => ({ name: cookie.name, expires_at: endOf(cookie) })), expires_at: ends.at(-1) ?? null });
    } catch (error) {
      origins.push({ origin, signed_in: false, reason: error?.code ?? 'sign_in_failed' });
    }
  }
  if (origins.some(one => one.signed_in)) {
    await door.secrets('secrets:put', { name: PROOF.session_value, value: JSON.stringify(Object.fromEntries(sessions)), hosts: hostsOf(accounts) });
  }
  // A code is used once: the value is marked spent whether or not its sign-in worked.
  await door.secrets('secrets:put', { name: PROOF.code_value, value: SPENT, hosts: hostsOf(accounts) });
  if (!origins.some(one => one.signed_in)) throw refuse('sign_in_failed', `No proof account signed in (${origins.map(one => `${one.origin} ${one.reason}`).join(', ')}).`);
  return { origins };
}
