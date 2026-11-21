// tools/connections/do-work/find-the-account-of-a-service.mjs
//
// PURPOSE
//   tool:find-the-account-of-a-service: which of the person's accounts of a service a call means when it names the service
//   with no account (`service_connection:stripe`, as a page or an AI that does not know the person's accounts says it).
//   The answer is read from the vault's held connection names the caller hands in (`held_connections`, the account files
//   read the same as tool:list-connections takes), never a value. Before Nov 21 2026 the engine decided this inside every
//   tool run (trillion-rust src/tool_runs/tools.rs `connection_found`, de9086d7d); the engine boundary audit moved the
//   policy here, to the owner of the person's connections, and a caller asks it before it starts the run.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Read only: it reads the two values it is handed and nothing else; it writes, checks and sends nothing.
//   2. An id that already names an account, or a bare id the vault holds a key under, is the caller's word: answered as
//      given. Otherwise the accounts the vault holds of that service are listed: one is the answer; several are named,
//      and no account is chosen (`connection_id` null, `which` saying to name one); none answers null with no accounts,
//      so the run's own credential refusal speaks.
//   3. Names no service: the id shape is find-the-account-of-a-service.json's, the words are its.
import { readFileSync } from 'node:fs';

const SETTINGS = JSON.parse(readFileSync(new URL('./find-the-account-of-a-service.json', import.meta.url), 'utf8'));

/** The service and account a connection id names: `<prefix><vendor>[:<account>]`, null for any other text. */
function parts(id) {
  if (typeof id !== 'string' || !id.startsWith(SETTINGS.connection_id_prefix)) return null;
  const [vendor, account, ...rest] = id.slice(SETTINGS.connection_id_prefix.length).split(':');
  if (!vendor || rest.length || account === '') return null;
  return { vendor, account: account ?? null };
}

/** tool:find-the-account-of-a-service: { service, held_connections } → { connection_id, accounts, which? }. */
export async function findTheAccountOfAService(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Array.isArray(input.held_connections)) {
    throw new Error(SETTINGS.words.send);
  }
  const named = parts(input.service);
  if (!named) throw new Error(SETTINGS.words.not_a_service);
  if (named.account) return { connection_id: input.service, accounts: [input.service] };
  const held = input.held_connections.map(item => item?.connection_id).filter(id => typeof id === 'string');
  if (held.includes(input.service)) return { connection_id: input.service, accounts: [input.service] };
  const accounts = [...new Set(held.filter(id => { const of = parts(id); return of?.vendor === named.vendor && of.account; }))].sort();
  if (accounts.length === 1) return { connection_id: accounts[0], accounts };
  if (accounts.length === 0) return { connection_id: null, accounts };
  return { connection_id: null, accounts, which: SETTINGS.words.which.replace('{accounts}', accounts.join(', ')) };
}
