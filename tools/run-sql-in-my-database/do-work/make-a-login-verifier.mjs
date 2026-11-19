// tools/run-sql-in-my-database/do-work/make-a-login-verifier.mjs
//
// Run by whoever will hold a login to someone else's database, on their own computer: reads their password, or the whole
// connection string they keep in their own vault, on stdin and prints the SCRAM-SHA-256 verifier Postgres keeps for it
// (RFC 5802 and RFC 5803: iterations, salt, StoredKey and ServerKey). They send only the verifier; the database's owner makes
// the login with it (run-sql.mjs, recipe.password_verifier), so the password never leaves the computer that keeps it.
// The password is never printed, logged or put in an argument.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// The iterations Postgres itself uses by default (scram_iterations); a caller may ask for more.
export const ITERATIONS = 4096;
// Printable ASCII needs no SASLprep, so the server and this file hash the same bytes; anything else is refused, not guessed.
const PRINTABLE = /^[\x21-\x7e]+$/;

// The password a value names: a connection string's own password, or the value itself.
export function passwordOf(value) {
  const text = String(value ?? '').trim();
  if (/^postgres(ql)?:\/\//.test(text)) {
    const password = decodeURIComponent(new URL(text).password);
    if (!password) throw new Error('The connection string has no password.');
    return password;
  }
  return text;
}

export function verifierOf(password, { iterations = ITERATIONS, salt = randomBytes(16) } = {}) {
  if (typeof password !== 'string' || password.length < 43) throw new Error('The password must be at least 43 characters (32 random bytes as base64url).');
  if (!PRINTABLE.test(password)) throw new Error('The password must be printable ASCII with no spaces.');
  if (!(Number.isInteger(iterations) && iterations >= ITERATIONS)) throw new Error(`iterations must be a whole number of at least ${ITERATIONS}.`);
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const storedKey = createHash('sha256').update(createHmac('sha256', salted).update('Client Key').digest()).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

const startedAsProgram = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (startedAsProgram) {
  try {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    process.stdout.write(`${JSON.stringify({ password_verifier: verifierOf(passwordOf(text)) })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
