#!/usr/bin/env node
// tools/keep-a-held-value-by-name/do-work/keep-a-held-value.mjs
//
// Purpose
//   Keeps one held value under a name in the person's own vault, through the engine's one door operation `held-values:put`
//   (src/secrets.rs HELD_VALUES_PUT), or with `--remove` removes the value held under a name through `held-values:remove`
//   (src/secrets.rs HELD_VALUES_REMOVE). The name is the first argument; the value is read from stdin and sent in the request body
//   only, and a removal reads no stdin. The person's own key (the Mac app's key, or the one `trillion login` keeps) is the credential, so the door admits the
//   call as the account's own signed-in principal (src/account/sign_in/reach.json: the account's full key reaches it).
//
// Non-Negotiable Invariants
//   1. The value never goes on a command line, into a log, into a file or into the answer. stdin only.
//   2. The answer is {name, accepted}: accepted means written at the writer, or queued sealed for the writer at a computer that is not the
//      writer (the engine settles it there). A removal answers {name, removed, issuer_status} (removed true when a value was held, false when none was) or,
//      at a computer that is not the writer, {name, queued: true, issuer_status}; it needs `--issuer-status revoked|unknown`, because
//      removing a held value does not revoke it at its issuer. The engine never returns the value.
//   3. Connection names (`service-connection-…`) are refused by the engine; this tool does not second-guess that.
//   4. One trailing newline that an `echo` or a pipe adds is removed; every other byte is the value, unchanged.
//
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentialFor, doorFor, trillionClient, TrillionError } from '../../use-trillion-from-a-shell/do-work/trillion.mjs';

const say = (message, status) => new TrillionError(message, { status });

/** Reads all of stdin as text. */
export async function readStdin(stream = process.stdin) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/** The value a stdin read holds: one trailing newline removed, nothing else. */
export const valueOf = text => (text.endsWith('\r\n') ? text.slice(0, -2) : text.endsWith('\n') ? text.slice(0, -1) : text);

/** Keeps `value` under `name` through the door. Answers { name, accepted: true }. */
export async function keepHeldValue({ name, value, client }) {
  if (typeof name !== 'string' || !name) throw say('Name the held value: keep-a-held-value-by-name NAME, then the value on stdin.', 2);
  if (!value) throw say('Pipe the value on stdin; it is empty.', 2);
  const answer = await client.op('@held-values', 'held-values:put', { name, value }, { requestKey: randomUUID() });
  if (answer?.accepted !== true) throw say('The door did not accept the held value.', 3);
  return { name, accepted: true };
}

/** What a removal says about the secret at its issuer: it was revoked there, or the issuer's state is not known. A removal that names neither is refused. */
export const ISSUER_STATUSES = ['revoked', 'unknown'];

/**
 * Removes the value held under `name` through the door. `issuerStatus` is recorded in the answer, never sent to the door: removing
 * a held value does not revoke it at its issuer, so the caller says whether that was done. One stable request key per removal
 * (`requestKey`), so a retry after a timeout is the same call. Answers { name, removed, issuer_status } or, away from the writer,
 * { name, queued: true, issuer_status }.
 */
export async function removeHeldValue({ name, issuerStatus, client, requestKey = `held-values-remove:${name}` }) {
  if (typeof name !== 'string' || !name) throw say('Name the held value: keep-a-held-value-by-name --remove NAME --issuer-status revoked|unknown.', 2);
  if (!ISSUER_STATUSES.includes(issuerStatus)) throw say(`Say what is known at the issuer: --issuer-status ${ISSUER_STATUSES.join(' or ')}.`, 2);
  const answer = await client.op('@held-values', 'held-values:remove', { name }, { requestKey });
  if (answer?.queued === true) return { name, queued: true, issuer_status: issuerStatus };
  if (typeof answer?.removed !== 'boolean') throw say('The door did not answer the removal.', 3);
  return { name, removed: answer.removed, issuer_status: issuerStatus };
}

async function main(argv, { stdin = process.stdin, print = line => process.stdout.write(`${line}\n`) } = {}) {
  const removing = argv[0] === '--remove';
  const name = removing ? argv[1] : argv[0];
  const issuerStatus = removing && argv[2] === '--issuer-status' ? argv[3] : undefined;
  const credential = await credentialFor();
  const client = trillionClient({ door: doorFor({ credential }), credential });
  if (removing) return print(JSON.stringify(await removeHeldValue({ name, issuerStatus, client })));
  const value = valueOf(await readStdin(stdin));
  print(JSON.stringify(await keepHeldValue({ name, value, client })));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.status ?? 1;
  });
}
