// tools/make-a-login-on-every-computer/do-work/make-a-login.mjs
//
// Makes one database login held by every computer the person names, and its database grants, in one run. The password is
// generated once in this process, put to each computer's vault through the door's secrets:put (the account's own key, as
// keep-a-secret-by-name does), read back by name on each computer, and only then made into a role on the database by the
// login's own maker (tool:run-sql-in-my-database a-login, pinned to the always-on computer, which holds the operator), then
// given its grants by the database's owner. The password never goes into an argument, stdout, a file or an answer.
//
// Non-Negotiable Invariants:
// - Put to every pin first, read back the name on every pin, and only then make the role. A refused put or a missing read-back
//   stops the run before any role is made, and the answer names the pin.
// - The password is generated here and nowhere else; the vault stores it as the connection string the door is given.
// - Every error message is scrubbed of the password before it leaves this process.
//
// Input (JSON on stdin): { login, database, host, pins, always_on, operator, grants? }
//   login      the role name (letters, digits, underscores), also the held connection's name prefix: <login>-connection
//   database   the database the login connects to and its grants apply in
//   host       the address the connection string names and the vault may send the value to
//   pins       every computer to hold the value, each a computer pin id (from input until the computers' rows exist)
//   always_on  the pin of the computer that holds the operator login (it makes the role)
//   operator   the operator login's held connection name (CREATEROLE), as the make step names it; needed when make_role is true
//   grants     optional { recipe } to run after the role is made, as the database's owner (credential <database>-connection)
//   make_role  true (the default) makes the role with a-login and gives grants; false only puts and reads back the value, for a
//              step that makes its own role (own-database creates the role and its database)
//
// Key Concepts: the door client is use-your-tools-from-a-shell's engineClient; opWhole answers a tool run whole.
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentialFor, doorFor, engineClient, opWhole, CommandError } from '../../use-your-tools-from-a-shell/do-work/command.mjs';

const say = (message, status) => new CommandError(message, { status });

const NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** A password of 32 random bytes, base64url: the same shape the login recipes accept as a standing password. */
export const passwordOf = () => randomBytes(32).toString('base64url');

/** The connection string the held name carries, in the shape the make-a-database recipe uses. */
export const connectionOf = ({ login, password, database, host }) => `postgresql://${login}:${password}@${host}:5432/${database}?sslmode=verify-full`;

/** Checks the input before anything is put anywhere. */
export function inputOf(given) {
  const { login, database, host, pins, always_on: alwaysOn, operator, grants, make_role: makeRole = true } = given ?? {};
  if (typeof login !== 'string' || !NAME.test(login)) throw say('login must be a role name: letters, digits and underscores.', 2);
  if (typeof database !== 'string' || !NAME.test(database)) throw say('database must be a database name: letters, digits and underscores.', 2);
  if (typeof host !== 'string' || host === '') throw say('host must be the database address.', 2);
  if (!Array.isArray(pins) || pins.length === 0 || pins.some(pin => typeof pin !== 'string' || pin === '')) throw say('pins must be a list of computer pin ids.', 2);
  if (new Set(pins).size !== pins.length) throw say('pins must name each computer once.', 2);
  if (typeof alwaysOn !== 'string' || !pins.includes(alwaysOn)) throw say('always_on must be one of the pins: the computer that holds the operator.', 2);
  if (typeof makeRole !== 'boolean') throw say('make_role must be true or false.', 2);
  if (makeRole && (typeof operator !== 'string' || operator === '')) throw say('operator must be the operator login\'s held connection name when make_role is true.', 2);
  if (grants !== undefined && (grants === null || typeof grants !== 'object' || typeof grants.recipe !== 'string' || grants.recipe === '')) throw say('grants must be { recipe } naming the grants recipe to run.', 2);
  return { login, database, host, pins, alwaysOn, operator, grants: grants ?? null, makeRole };
}

/** Runs one tool through the door, pinned to a computer, and answers its whole answer. */
const runTool = (client, pin, tool, input) => opWhole(client, null, 'tools:run', { tool, input }, { requestKey: randomUUID(), route: { pins: [pin] } });

/**
 * Makes the login held by every pin and its grants. Answers { login, held_name, held_at, role_made, grants }; never the password.
 * `password` is for the test only: a run makes its own.
 */
export async function makeLogin({ input, client, password = passwordOf() }) {
  const { login, database, host, pins, alwaysOn, operator, grants, makeRole } = inputOf(input);
  const heldName = `${login}-connection`;
  const value = connectionOf({ login, password, database, host });
  const scrub = text => String(text).split(password).join('<redacted>');
  try {
    for (const pin of pins) {
      const answer = await client.op('@secrets', 'secrets:put', { name: heldName, value, hosts: [host] }, { requestKey: randomUUID(), route: { pins: [pin] } });
      if (answer?.accepted !== true) throw say(`The vault at ${pin} did not accept ${heldName}; no role was made.`, 3);
    }
    for (const pin of pins) {
      const names = await client.op('@secrets', 'secrets:names', {}, { requestKey: randomUUID(), route: { pins: [pin] } });
      if (!Array.isArray(names?.names) || !names.names.includes(heldName)) throw say(`${heldName} is not held at ${pin} on read-back; no role was made.`, 3);
    }
    if (!makeRole) return { login, held_name: heldName, held_at: pins, role_made: false, grants: null };
    const made = await runTool(client, alwaysOn, 'tool:run-sql-in-my-database', { credential_name: operator, role_credential_name: heldName, recipe: { name: 'a-login', action: 'create' } });
    if (made?.exit_code !== 0) throw say(`The login was not made at ${alwaysOn}: ${made?.error ?? 'no answer'}.`, 3);
    if (grants) {
      const granted = await runTool(client, alwaysOn, 'tool:run-sql-in-my-database', { credential_name: `${database}-connection`, recipe: { name: grants.recipe, action: 'create', role: login } });
      if (granted?.exit_code !== 0) throw say(`The grants ${grants.recipe} were not given at ${alwaysOn}: ${granted?.error ?? 'no answer'}.`, 3);
    }
    return { login, held_name: heldName, held_at: pins, role_made: true, grants: grants ? grants.recipe : null };
  } catch (error) {
    throw new CommandError(scrub(error.message), { status: error.status ?? 1 });
  }
}

async function main(stdin = process.stdin, print = line => process.stdout.write(`${line}\n`)) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const credential = await credentialFor();
  const client = engineClient({ door: doorFor({ credential }), credential });
  print(JSON.stringify(await makeLogin({ input, client })));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.status ?? 1;
  });
}
