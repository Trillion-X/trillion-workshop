// tools/read-and-write-mail/read-data/mail.mjs
//
// Purpose: the one entry every mail tool row runs (through tools/workflows/do-work/run-a-function.mjs, one exported
// function per operation). It reads the provider the run names from read-data/mail-providers.json, takes the person's
// key from the descriptor the engine handed this run, and gives the request to the provider's adapter
// (read-data/adapters/<adapter>.mjs), which turns it into the provider's own requests and the replies into the neutral
// message rows of read-data/neutral.mjs. Nothing here names a provider or a wire format.
//
// Non-Negotiable Invariants:
// 1. The key is read from descriptor 4 only when a request needs it, kept in this run's memory, and placed only in the
//    Authorization header of a request to a host of the provider's row, over https, never followed by a redirect.
// 2. A provider that does not offer an operation is refused before any request leaves, in the words of its row.
// 3. A refusal is a Refused with words a person can read; the provider's own reply is quoted only up to SAID characters.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { makeComposioProxy } from '../../composio-connection/read-data/composio-call.mjs';
import { blake3 } from '../../content-identity/read-data/blake3.mjs';
import { MOST_ATTACHMENT_BYTES } from './neutral.mjs';

const HELD_DESCRIPTOR = 4;
const SAID = 300;
const KEPT = '/opt/read-and-write-mail/out/attachment';
const rows = JSON.parse(readFileSync(new URL('./mail-providers.json', import.meta.url), 'utf8'));

export class Refused extends Error {}

const fill = (words, values) => Object.entries(values).reduce((text, [key, value]) => text.split(`{${key}}`).join(String(value)), words);
const providerIds = () => rows.providers.map(row => row.id).join(', ');
const jobOf = operation => operation.replace(/-/g, ' ');

/** The provider row an input names. */
export function providerFor(input) {
  const named = input?.provider;
  if (typeof named !== 'string' || !named) throw new Refused(fill(rows.words.no_provider, { providers: providerIds() }));
  const provider = rows.providers.find(row => row.id === named);
  if (!provider) throw new Refused(fill(rows.words.no_such_provider, { provider: named, providers: providerIds() }));
  return provider;
}

/** `call(method, path, {query, body, headers})`: one request to the provider's own host, as the person. `path` is added
 *  to the provider's base_url (a path part is encoded by its caller); a query value that is a list is the name repeated,
 *  null and undefined are left out. An address a reply handed over (a paging link) may be given whole when it is inside
 *  the base_url. The reply is its JSON, or null when it has none. */
export function makeCall(provider, io = {}) {
  if (provider.transport === 'composio-proxy') return makeProxiedCall(provider, io);
  const { read = descriptor => readFileSync(descriptor, 'utf8'), send = fetch } = io;
  let key = null;
  const held = () => {
    if (key === null) key = String(read(HELD_DESCRIPTOR)).trim();
    if (!key) throw new Refused(fill(rows.words.no_key, { label: provider.label }));
    return key;
  };
  return async function call(method, path, { query = {}, body, headers = {} } = {}) {
    const url = path.startsWith(provider.base_url) ? new URL(path) : new URL(provider.base_url + path);
    for (const [name, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(name, String(item));
    }
    if (url.protocol !== 'https:' || !provider.hosts.includes(url.hostname)) throw new Refused(fill(rows.words.host, { hosts: provider.hosts.join(', '), host: url.hostname }));
    const reply = await send(url, {
      method,
      redirect: 'manual',
      headers: { Authorization: `Bearer ${held()}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await reply.text();
    if (!reply.ok) throw new Refused(fill(rows.words.refused, { label: provider.label, status: reply.status, said: text.replace(/\s+/g, ' ').trim().slice(0, SAID) }));
    if (!text.trim()) return null;
    try { return JSON.parse(text); } catch { throw new Refused(fill(rows.words.refused, { label: provider.label, status: reply.status, said: 'the reply was not JSON' })); }
  };
}

/** The same `call` for a provider whose requests the Composio proxy sends with the person's connected account: the request
 *  goes to the provider's own address as one proxy request, and the account's ids come from the connection the run names. */
function makeProxiedCall(provider, { connection = {}, read, send } = {}) {
  const proxy = makeComposioProxy({ read, send });
  return async function call(method, path, { query = {}, body, headers = {} } = {}) {
    const url = path.startsWith(provider.base_url) ? new URL(path) : new URL(provider.base_url + path);
    for (const [name, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(name, String(item));
    }
    const parameters = Object.entries(headers).map(([name, value]) => ({ name, value: String(value), in: 'header' }));
    const { data } = await proxy({ endpoint: url.toString(), method, ...(body === undefined ? {} : { body }), ...(parameters.length ? { parameters } : {}) },
      connection.connection_id, connection.user_id, connection.project_id);
    return data;
  };
}

/** Fetches an attachment's bytes from the address a provider handed over (a signed download address). No key is sent: the
 *  address carries its own grant, and it must be https. The reply is refused when it is larger than MOST_ATTACHMENT_BYTES. */
export async function download(provider, url, io = {}) {
  const { send = fetch } = io;
  const target = new URL(url);
  if (target.protocol !== 'https:') throw new Refused(fill(rows.words.not_a_download, { label: provider.label }));
  // The address is signed, so only its host is ever named in a word: a failed fetch says which host and the error code.
  let reply;
  try {
    reply = await send(target, { method: 'GET', redirect: 'manual', headers: { Accept: 'application/octet-stream' } });
  } catch (error) {
    throw new Refused(fill(rows.words.download_failed, { label: provider.label, host: target.hostname, cause: error?.cause?.code ?? error?.code ?? error?.message ?? 'unknown' }));
  }
  if (!reply.ok) throw new Refused(fill(rows.words.download_refused, { label: provider.label, status: reply.status }));
  const size = Number(reply.headers?.get?.('content-length'));
  if (Number.isFinite(size) && size > MOST_ATTACHMENT_BYTES) throw new Refused(fill(rows.words.too_large, { label: provider.label, max: MOST_ATTACHMENT_BYTES, size }));
  const bytes = Buffer.from(await reply.arrayBuffer());
  if (bytes.length > MOST_ATTACHMENT_BYTES) throw new Refused(fill(rows.words.too_large, { label: provider.label, max: MOST_ATTACHMENT_BYTES, size: bytes.length }));
  return bytes;
}

/** Runs one operation for the provider the input names. `io` is only for tests: the descriptor reader and the fetch. */
export async function perform(operation, input = {}, io = {}) {
  const provider = providerFor(input);
  if (!provider.operations.includes(operation)) throw new Refused(fill(rows.words.not_offered, { label: provider.label, job: jobOf(operation) }));
  if (!/^[a-z-]+$/.test(provider.adapter)) throw new Refused(fill(rows.words.not_offered, { label: provider.label, job: jobOf(operation) }));
  const adapter = await import(`./adapters/${provider.adapter}.mjs`);
  const run = adapter.operations[operation];
  if (typeof run !== 'function') throw new Refused(fill(rows.words.not_offered, { label: provider.label, job: jobOf(operation) }));
  const { provider: _named, connection, ...asked } = input;
  return run({ provider, call: makeCall(provider, { ...io, connection }), download: url => download(provider, url, io), words: rows.words, fill, Refused }, asked);
}

const operation = name => input => perform(name, input);
export const findMyMailbox = operation('find-my-mailbox');
export const listNewMail = operation('list-new-mail');
export const findMail = operation('find-mail');
export const readMailHeaders = operation('read-mail-headers');
export const readAMail = operation('read-a-mail');
export const readAConversation = operation('read-a-conversation');
export const organizeMail = operation('organize-mail');
export const organizeAConversation = operation('organize-a-conversation');
export const trashMail = operation('trash-mail');
export const restoreMail = operation('restore-mail');
export const trashAConversation = operation('trash-a-conversation');
export const restoreAConversation = operation('restore-a-conversation');
export const listMailDrafts = operation('list-mail-drafts');
export const readAMailDraft = operation('read-a-mail-draft');
export const saveAMailDraft = operation('save-a-mail-draft');
export const deleteAMailDraft = operation('delete-a-mail-draft');
export const sendAMailDraft = operation('send-a-mail-draft');
export const listSendAsAddresses = operation('list-send-as-addresses');
export const setAMailSignature = operation('set-a-mail-signature');

/** Keeps one attachment as a file of the run: the bytes are written to the kept output (data only, never opened) and the
 *  answer is its name, its size, its media type and its BLAKE3 identity. `io.out` is only for tests. */
export async function keepAMailAttachment(input = {}, io = {}) {
  const found = await perform('keep-a-mail-attachment', input, io);
  const out = io.out ?? KEPT;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, found.bytes);
  return { name: found.name, bytes: found.bytes.length, media_type: found.media_type, blake3: Buffer.from(blake3(found.bytes)).toString('hex') };
}
