// tools/copy-a-file-into-a-storage-place/do-work/copy-a-file-into-a-storage-place.mjs
//
// Purpose: copy one file the person can read by address (a share link of their files, any size) into a folder of a storage place
// they were given (a Google Drive folder, a OneDrive folder, any kind read-data/storage-places.json describes), one piece at a time.
// First it asks the place whether this account may add a file to the folder and, when it may not, answers exactly that and copies
// nothing. Then it opens a resumable upload with the account's connection (the only request that carries a credential) and sends
// the bytes to the session's own address: each piece is read from the source by range and sent on, so memory holds one piece
// whatever the file's size.
//
// The account's connection is one of two kinds, named by `connection.kind`: `bearer` (the account's own access token on
// descriptor 4, sent as Authorization to the place's own host) or `composio` (the Composio key on descriptor 4 and the connected
// account's id: the request goes through Composio's proxy, which adds the account's credential). Nothing here names a place.
//
// Non-Negotiable Invariants:
// - Nothing is copied into a folder the place says this account may not add to; the answer says so in words, with the folder's name.
// - The credential is read from descriptor 4 only when a request needs it and goes only to the place's host (bearer) or to Composio.
// - The session's address is never answered, logged or kept: it takes the bytes with no other credential.
// - A piece the source answers short, or the place refuses, ends the copy with the place's own words; the copy is never called done
//   until the place answers the last piece with the new file.
import { readFileSync } from 'node:fs';

const places = JSON.parse(readFileSync(new URL('../read-data/storage-places.json', import.meta.url), 'utf8'));
const HELD = 4;
const SAID = 300;
const COMPOSIO_PROXY = 'https://backend.composio.dev/api/v3/tools/execute/proxy';
const DEFAULT_PIECE = 8 * 1024 * 1024;
const MOST_PIECE = 64 * 1024 * 1024;

export class Refused extends Error {}

const pointer = (value, path) => path.split('/').slice(1).reduce((at, key) => (at == null ? undefined : at[key.replace(/~1/g, '/').replace(/~0/g, '~')]), value);
const filled = (value, fields) => typeof value === 'string'
  ? value.replace(/\{(\w+)\}/g, (_, field) => (field in fields ? String(fields[field]) : `{${field}}`))
  : Array.isArray(value) ? value.map(item => filled(item, fields))
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, filled(item, fields)]))
  : value;
const said = text => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, SAID);

/** One request to the place, carrying the account's credential: answers { status, headers (lower-case names), data }. */
export function makePlaceRequest({ connection, read = fd => readFileSync(fd, 'utf8'), send = fetch }) {
  let key = null;
  const held = () => {
    if (key === null) key = String(read(HELD)).trim();
    if (!key) throw new Refused('The connection\'s credential is not held on descriptor 4, so nothing was sent.');
    return key;
  };
  if (connection?.kind === 'composio') {
    if (typeof connection.account !== 'string' || !connection.account) throw new Refused('A Composio connection names its connected account id (account).');
    return async ({ method, url, query = {}, headers = {}, body }) => {
      const parameters = [...Object.entries(query).map(([name, value]) => ({ name, value: String(value), type: 'query' })),
        ...Object.entries(headers).map(([name, value]) => ({ name, value: String(value), type: 'header' }))];
      const reply = await send(COMPOSIO_PROXY, { method: 'POST', redirect: 'manual',
        headers: { 'x-api-key': held(), Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ connected_account_id: connection.account, endpoint: url, method, parameters, ...(body === undefined ? {} : { body }) }) });
      const text = await reply.text();
      if (!reply.ok) throw new Refused(`Composio did not pass the request on (${reply.status}): ${said(text)}`);
      const answer = JSON.parse(text);
      const lower = Object.fromEntries(Object.entries(answer.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
      return { status: Number(answer.status), headers: lower, data: answer.data };
    };
  }
  if (connection?.kind === 'bearer') {
    return async ({ method, url, query = {}, headers = {}, body }) => {
      const address = new URL(url);
      for (const [name, value] of Object.entries(query)) address.searchParams.set(name, value);
      if (address.protocol !== 'https:') throw new Refused(`A credential goes only over https, so nothing was sent to ${address.host}.`);
      const reply = await send(address, { method, redirect: 'manual',
        headers: { Authorization: `Bearer ${held()}`, ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json; charset=UTF-8' }) },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await reply.text();
      let data = text;
      try { data = text ? JSON.parse(text) : null; } catch { /* the place's own words */ }
      return { status: reply.status, headers: Object.fromEntries([...reply.headers].map(([name, value]) => [name.toLowerCase(), value])), data };
    };
  }
  throw new Refused('Name the account\'s connection: {kind: "bearer"} (its token on descriptor 4) or {kind: "composio", account} (the Composio key on descriptor 4).');
}

/** Copy `from` (an https address answering byte ranges, and its `byte_length`) into `to` ({place, folder, name, media_type}). */
export async function copyAFileIntoAStoragePlace(input, _host, { request, send = fetch } = {}) {
  const { from, to, via, account, piece_bytes: asked } = input ?? {};
  // `via` is how the account was connected (the row's by_input variant): through Composio (its key on descriptor 4 and the connected
  // account's id), or straight (any other value: the account's own token on descriptor 4).
  const connection = input?.connection ?? (via === 'composio' ? { kind: 'composio', account } : { kind: 'bearer' });
  const place = places[to?.place];
  if (!place || to.place.startsWith('_')) throw new Refused(`A storage place is one of ${Object.keys(places).filter(kind => !kind.startsWith('_')).join(', ')}; ${JSON.stringify(to?.place)} is not described.`);
  for (const field of ['folder', 'name']) if (typeof to[field] !== 'string' || !to[field]) throw new Refused(`Say the ${field} to copy into.`);
  const length = Number(from?.byte_length);
  if (typeof from?.url !== 'string' || !/^https:\/\//.test(from.url) || !Number.isSafeInteger(length) || length < 1) {
    throw new Refused('Give the file to copy as {url (an https address that answers byte ranges, such as a share link), byte_length}.');
  }
  const unit = place.piece.multiple_of;
  const size = Math.max(unit, Math.min(MOST_PIECE, Math.floor((Number(asked) || DEFAULT_PIECE) / unit) * unit));
  const ask = request ?? makePlaceRequest({ connection, send });
  const fields = { folder: to.folder, name: to.name, media_type: to.media_type || 'application/octet-stream', byte_length: length };

  const checked = await ask(filled(place.check, fields));
  if (checked.status === 404) return { copied: false, said: `${place.words} has no folder ${to.folder} that this account can see.` };
  if (checked.status >= 400) return { copied: false, said: `${place.words} would not say whether this account may add to folder ${to.folder} (${checked.status}): ${said(JSON.stringify(checked.data))}` };
  const folderName = pointer(checked.data, place.check.name_at) ?? to.folder;
  if (!pointer(checked.data, place.check.may_add_at)) {
    return { copied: false, folder: folderName, said: `You may not add files to "${folderName}" in ${place.words}: its owner has not given this account the right to add to it. Nothing was copied.` };
  }

  const opened = await ask(filled(place.open, fields));
  const session = place.open.session_header ? opened.headers?.[place.open.session_header] : pointer(opened.data, place.open.session_at);
  if (opened.status >= 400 || typeof session !== 'string' || !session.startsWith('https://')) {
    return { copied: false, folder: folderName, said: `${place.words} did not open an upload into "${folderName}" (${opened.status}): ${said(JSON.stringify(opened.data))}` };
  }

  let pieces = 0;
  for (let start = 0; start < length; start += size) {
    const end = Math.min(length, start + size) - 1;
    const source = await send(from.url, { headers: { Range: `bytes=${start}-${end}` }, redirect: 'follow' });
    const bytes = Buffer.from(await source.arrayBuffer());
    if (source.status !== 206 && !(source.status === 200 && start === 0 && end === length - 1) || bytes.length !== end - start + 1) {
      return { copied: false, folder: folderName, pieces, said: `The file stopped answering at byte ${start} (${source.status}); ${pieces} pieces were sent and the copy was not finished.` };
    }
    const put = await send(session, { method: 'PUT', headers: { 'Content-Range': `bytes ${start}-${end}/${length}`, 'Content-Length': String(bytes.length) }, body: bytes });
    pieces += 1;
    const last = end === length - 1;
    if (!last && place.piece.more.includes(put.status)) continue;
    const text = await put.text();
    if (last && place.piece.done.includes(put.status)) {
      let made = null;
      try { made = JSON.parse(text); } catch { /* answered with no JSON */ }
      return { copied: true, folder: folderName, name: to.name, id: pointer(made, place.piece.id_at) ?? null, byte_length: length, pieces, said: `Copied ${to.name} (${length} bytes) into "${folderName}" in ${place.words}.` };
    }
    return { copied: false, folder: folderName, pieces, said: `${place.words} refused piece ${pieces} (${put.status}): ${said(text)}` };
  }
  return { copied: false, folder: folderName, pieces, said: 'The copy ended without the place answering its last piece.' };
}
