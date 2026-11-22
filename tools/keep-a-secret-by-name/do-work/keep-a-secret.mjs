#!/usr/bin/env node
// tools/keep-a-secret-by-name/do-work/keep-a-secret.mjs
//
// Purpose
//   Keeps one secret under a name in the person's own vault, through the engine's one door operation `secrets:put`
//   (src/secrets.rs SECRETS_PUT), or with `--remove` removes the value held under a name through `secrets:remove`
//   (src/secrets.rs SECRETS_REMOVE). The name is the first argument; the value is read from stdin and sent in the request body
//   only, and a removal reads no stdin. The person's own key (the Mac app's key, or the one `trillion login` keeps) is the credential, so the door admits the
//   call as the account's own signed-in principal (src/account/sign_in/reach.json: the account's full key reaches it).
//
// Non-Negotiable Invariants
//   1. The value never goes on a command line, into a log, into a file or into the answer. stdin only.
//   2. The answer is {name, accepted}: accepted means written at the writer, or queued sealed for the writer at a computer that is not the
//      writer (the engine settles it there). A removal answers {name, removed, issuer_status} (removed true when a value was held, false when none was) or,
//      at a computer that is not the writer, {name, queued: true, issuer_status}; it needs `--issuer-status revoked|unknown`, because
//      removing a secret does not revoke it at its issuer. The engine never returns the value.
//   3. Connection names (`service-connection-…`) are refused by the engine; this tool does not second-guess that.
//   4. One trailing newline that an `echo` or a pipe adds is removed; every other byte is the value, unchanged.
//   5. `--hosts a.example,b.example` after the name says the only hosts the value may be sent to, and travels as the input's `hosts`.
//      Without it the engine keeps a new value going nowhere and a replaced one keeps the hosts it had (src/secrets.rs SECRETS_PUT).
//
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentialFor, doorFor, speakAsInstalledSite, engineClient, CommandError } from '../../use-your-tools-from-a-shell/do-work/command.mjs';

const say = (message, status) => new CommandError(message, { status });

/** Reads all of stdin as text. */
export async function readStdin(stream = process.stdin) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/** The value a stdin read holds: one trailing newline removed, nothing else. */
export const valueOf = text => (text.endsWith('\r\n') ? text.slice(0, -2) : text.endsWith('\n') ? text.slice(0, -1) : text);

/** The hosts a `--hosts` argument names: comma-separated, blanks dropped. */
export const hostsOf = text => String(text ?? '').split(',').map(host => host.trim()).filter(Boolean);

/** Keeps `value` under `name` through the door, sent only to `hosts` when they are given. Answers { name, accepted: true } and the hosts. */
export async function keepSecret({ name, value, hosts, client }) {
  if (typeof name !== 'string' || !name) throw say('Name the secret: keep-a-secret-by-name NAME [--hosts HOST,HOST], then the value on stdin.', 2);
  if (!value) throw say('Pipe the value on stdin; it is empty.', 2);
  if (hosts !== undefined && !hosts.length) throw say('Name at least one host after --hosts, for example --hosts api.example.com.', 2);
  const input = hosts ? { name, value, hosts } : { name, value };
  const answer = await client.op('@secrets', 'secrets:put', input, { requestKey: randomUUID() });
  if (answer?.accepted !== true) throw say('The door did not accept the secret.', 3);
  return hosts ? { name, accepted: true, hosts } : { name, accepted: true };
}

/** What a removal says about the secret at its issuer: it was revoked there, or the issuer's state is not known. A removal that names neither is refused. */
export const ISSUER_STATUSES = ['revoked', 'unknown'];

/**
 * Removes the value held under `name` through the door. `issuerStatus` is recorded in the answer, never sent to the door: removing
 * a secret does not revoke it at its issuer, so the caller says whether that was done. One stable request key per removal
 * (`requestKey`), so a retry after a timeout is the same call. Answers { name, removed, issuer_status } or, away from the writer,
 * { name, queued: true, issuer_status }.
 */
export async function removeSecret({ name, issuerStatus, client, requestKey = `secrets-remove:${name}` }) {
  if (typeof name !== 'string' || !name) throw say('Name the secret: keep-a-secret-by-name --remove NAME --issuer-status revoked|unknown.', 2);
  if (!ISSUER_STATUSES.includes(issuerStatus)) throw say(`Say what is known at the issuer: --issuer-status ${ISSUER_STATUSES.join(' or ')}.`, 2);
  const answer = await client.op('@secrets', 'secrets:remove', { name }, { requestKey });
  if (answer?.queued === true) return { name, queued: true, issuer_status: issuerStatus };
  if (typeof answer?.removed !== 'boolean') throw say('The door did not answer the removal.', 3);
  return { name, removed: answer.removed, issuer_status: issuerStatus };
}

async function main(argv, { stdin = process.stdin, print = line => process.stdout.write(`${line}\n`) } = {}) {
  const removing = argv[0] === '--remove';
  const name = removing ? argv[1] : argv[0];
  const issuerStatus = removing && argv[2] === '--issuer-status' ? argv[3] : undefined;
  speakAsInstalledSite();
  const credential = await credentialFor();
  const client = engineClient({ door: doorFor({ credential }), credential });
  if (removing) return print(JSON.stringify(await removeSecret({ name, issuerStatus, client })));
  const hosts = argv[1] === '--hosts' ? hostsOf(argv[2]) : undefined;
  const value = valueOf(await readStdin(stdin));
  print(JSON.stringify(await keepSecret({ name, value, hosts, client })));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.status ?? 1;
  });
}
