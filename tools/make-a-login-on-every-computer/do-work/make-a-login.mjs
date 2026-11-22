// tools/make-a-login-on-every-computer/do-work/make-a-login.mjs
//
// Makes this computer's own database login for one pursuit, held in this computer's vault, and gives it its grants. Each computer
// runs this for itself: it makes its own password in this process, makes its own role on the database (the role name carries the
// computer, so one computer's login can be revoked alone), puts the connection string under the shared held name in its own
// vault, reads the name back, and gives the role its grants. No value leaves this computer: nothing is put to another computer.
//
// Non-Negotiable Invariants:
// - Put, then read back the name on this computer, and only then make the role. A refused put or a missing read-back stops the run
//   before any role is made. A role that already exists keeps its password: a re-run checks the held value and goes on to the grants.
// - The password is generated here and nowhere else; the vault stores it as the connection string the door is given.
// - Every error message is scrubbed of the password before it leaves this process.
//
// Input (JSON on stdin): { login, database, host, computer, operator, grants?, make_role? }
//   login      the login's base name (letters, digits, underscores), e.g. ethos_for_who_runs_it_post_writer; the held name is <login>-connection
//   database   the database the login connects to and its grants apply in
//   host       the address the connection string names and the vault may send the value to
//   computer   this computer's short name, carried in the role name: <login>_<computer>
//   operator   this computer's operator login's held connection name (CREATEROLE), as the make step names it; needed when make_role is true
//   grants     optional { recipe } to run after the role is made, as the database's owner (credential <database>-connection, held here)
//   make_role  true (the default) makes the role with a-login and gives grants; false only puts and reads back, for a step that makes its
//              own role (own-database creates the role and its database)
//
// Key Concepts: the door client is use-your-tools-from-a-shell's engineClient; opWhole answers a tool run whole. A call with no route is
// this computer's own door (a run's right is valid only on its own computer).
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentialFor, doorFor, speakAsInstalledSite, engineClient, opWhole, CommandError } from '../../use-your-tools-from-a-shell/do-work/command.mjs';

const say = (message, status) => new CommandError(message, { status });

const NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const SHORT = /^[a-z0-9][a-z0-9-]{0,30}$/;

/** A password of 32 random bytes, base64url: the same shape the login recipes accept as a standing password. */
export const passwordOf = () => randomBytes(32).toString('base64url');

/** The connection string the held name carries, in the shape the make-a-database recipe uses. */
export const connectionOf = ({ role, password, database, host }) => `postgresql://${role}:${password}@${host}:5432/${database}?sslmode=verify-full`;

/** Checks the input before anything is put anywhere; answers the run's own names. */
export function inputOf(given) {
  const { login, database, host, computer, operator, grants, make_role: makeRole = true } = given ?? {};
  if (typeof login !== 'string' || !NAME.test(login)) throw say('login must be a name: letters, digits and underscores.', 2);
  if (typeof database !== 'string' || !NAME.test(database)) throw say('database must be a database name: letters, digits and underscores.', 2);
  if (typeof host !== 'string' || host === '') throw say('host must be the database address.', 2);
  if (typeof computer !== 'string' || !SHORT.test(computer)) throw say('computer must be this computer\'s short name: lowercase letters, digits and hyphens.', 2);
  if (typeof makeRole !== 'boolean') throw say('make_role must be true or false.', 2);
  if (makeRole && (typeof operator !== 'string' || operator === '')) throw say('operator must be this computer\'s operator login held connection name when make_role is true.', 2);
  if (grants !== undefined && (grants === null || typeof grants !== 'object' || typeof grants.recipe !== 'string' || grants.recipe === '')) throw say('grants must be { recipe } naming the grants recipe to run.', 2);
  const role = `${login}_${computer.replaceAll('-', '_')}`;
  if (!NAME.test(role)) throw say('the role name (login and computer) is too long or not a name.', 2);
  return { login, database, host, computer, operator, grants: grants ?? null, makeRole, role };
}

/** Runs one tool on this computer's own door and answers its whole answer. */
const runTool = (client, tool, input) => opWhole(client, null, 'tools:run', { tool, input }, { requestKey: randomUUID(), route: {} });

/** Whether this computer's database role already exists, asked as this computer's operator. */
async function roleExists(client, operator, role) {
  const asked = await runTool(client, 'tool:run-sql-in-my-database', { credential_name: operator, sql: 'SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1', params: [role] });
  if (asked?.exit_code !== 0) throw say(`The role could not be looked up: ${asked?.error ?? 'no answer'}.`, 3);
  return asked.result.rows[0].n > 0;
}

/** Reads the held name back on this computer; a missing one stops the run. */
async function readBack(client, heldName, why) {
  const names = await client.op('@secrets', 'secrets:names', {}, { requestKey: randomUUID(), route: {} });
  if (!Array.isArray(names?.names) || !names.names.includes(heldName)) throw say(`${heldName} is not held on this computer on read-back; ${why}.`, 3);
}

/**
 * Makes this computer's login and its grants. Answers { login, role, held_name, held_at, role_made, grants }; never the password.
 * `password` is for the test only: a run makes its own.
 */
export async function makeLogin({ input, client, password = passwordOf() }) {
  const { login, database, host, computer, operator, grants, makeRole, role } = inputOf(input);
  const heldName = `${login}-connection`;
  const value = connectionOf({ role, password, database, host });
  const scrub = text => String(text).split(password).join('<redacted>');
  try {
    const existing = makeRole ? await roleExists(client, operator, role) : false;
    if (existing) {
      await readBack(client, heldName, 'the role exists, so its held value must already be on this computer: a password reset is needed');
    } else {
      const answer = await client.op('@secrets', 'secrets:put', { name: heldName, value, hosts: [host] }, { requestKey: randomUUID(), route: {} });
      if (answer?.accepted !== true) throw say(`This computer's vault did not accept ${heldName}; no role was made.`, 3);
      await readBack(client, heldName, 'no role was made');
    }
    if (!makeRole) return { login, role, held_name: heldName, held_at: [computer], role_made: false, grants: null };
    if (!existing) {
      const made = await runTool(client, 'tool:run-sql-in-my-database', { credential_name: operator, role_credential_name: heldName, recipe: { name: 'a-login', action: 'create' } });
      if (made?.exit_code !== 0) throw say(`The login was not made: ${made?.error ?? 'no answer'}.`, 3);
    }
    if (grants) {
      const granted = await runTool(client, 'tool:run-sql-in-my-database', { credential_name: `${database}-connection`, recipe: { name: grants.recipe, action: 'create', role } });
      if (granted?.exit_code !== 0) throw say(`The grants ${grants.recipe} were not given: ${granted?.error ?? 'no answer'}.`, 3);
    }
    return { login, role, held_name: heldName, held_at: [computer], role_made: true, grants: grants ? grants.recipe : null };
  } catch (error) {
    throw new CommandError(scrub(error.message), { status: error.status ?? 1 });
  }
}

async function main(stdin = process.stdin, print = line => process.stdout.write(`${line}\n`)) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  speakAsInstalledSite();
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
