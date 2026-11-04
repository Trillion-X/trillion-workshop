// tools/sync-files-between-my-computers/do-work/lan-peers.mjs (moved from old trillion computer/lan-peers.mjs)
//
// PURPOSE
//   Other computers of the same account on the same network as a source of file bytes, before Trillion's servers: one
//   computer that already holds a whole file on disk serves it to another that asks for it by content identity. This module
//   is the pure part (request signing, the table of known peers, announcements, the verified fetch); whoever keeps the
//   files on a computer mounts it beside its other byte sources.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Off unless `peers.enabled` (sync-files.json). Nothing listens and nothing is announced otherwise.
//   2. A peer proves it belongs to this account without sending the key: every request carries the sender's computer
//      identity, the time and a BLAKE3 keyed MAC over method, target, identity and time, made with a key derived from the
//      account's agent key (`peerKey`). A request outside `window_seconds`, with a bad MAC or from this computer itself is
//      refused. The account key itself never leaves the computer.
//   3. A Drive serves only a file the requester already names by BLAKE3 identity and length, and only when every block of
//      it is whole on disk. It decides nothing about who may read what; the other Drive reads it as the same account.
//   4. A fetched file is accepted only when the BLAKE3 of all its bytes equals the identity the requester named. A peer
//      that sends anything else is put on a cooldown (`bad_peer_seconds`) and the next source is tried.
//   5. Every size, time, port and list here is DATA (`peers` in sync-files.json).
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { createSocket } from 'node:dgram';
import { timingSafeEqual } from 'node:crypto';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { makeHashCodeHasher, makeHashCodeHexFromBytes, makeKeyedHashHexFromBytes } from '../../content-identity/read-data/identity.mjs';

export const IDENTITY = /^1f:[0-9a-f]{64}$/;
const HEADER = { id: 'x-trillion-peer-id', time: 'x-trillion-peer-time', mac: 'x-trillion-peer-mac' };

/** The key peers of this account share, derived so the account key itself is never sent or used as a MAC key. */
export const peerKey = secret => hexToBytes(makeHashCodeHexFromBytes(utf8ToBytes(`trillion lan peer v1\0${secret}`)).slice(3));
const macOf = (key, text) => makeKeyedHashHexFromBytes(key, utf8ToBytes(text));
const sameHex = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createPeers({ config, secret, selfId, now = Date.now, fetchImpl = fetch, log = () => {} }) {
  const key = peerKey(secret);
  const known = new Map(); // url -> { id, until_ms }
  const cooling = new Map(); // url -> until_ms
  for (const url of config.known) known.set(url, { id: null, until_ms: Infinity });
  const windowMs = config.window_seconds * 1000;

  const signed = (method, target) => {
    const time = String(now());
    return { [HEADER.id]: selfId, [HEADER.time]: time, [HEADER.mac]: macOf(key, `${method}\n${target}\n${selfId}\n${time}`) };
  };
  /** null when the request is from a peer of this account, else why it is refused. */
  function verify(method, target, headers) {
    const id = headers[HEADER.id], time = Number(headers[HEADER.time]);
    if (!id || !Number.isFinite(time) || Math.abs(now() - time) > windowMs) return 'The request is outside its time window.';
    if (id === selfId) return 'A computer does not ask itself.';
    return sameHex(headers[HEADER.mac], macOf(key, `${method}\n${target}\n${id}\n${headers[HEADER.time]}`)) ? null : 'The request is not signed by this account.';
  }

  // ---- announcements (UDP) -------------------------------------------------------------------------------------------
  const announcement = url => {
    const time = String(now());
    return JSON.stringify({ v: 1, id: selfId, url, time, mac: macOf(key, `announce\n${selfId}\n${url}\n${time}`) });
  };
  function heard(message) {
    let seen;
    try { seen = JSON.parse(String(message)); } catch { return false; }
    if (seen?.v !== 1 || typeof seen.url !== 'string' || typeof seen.id !== 'string' || seen.id === selfId) return false;
    if (!/^https?:\/\//.test(seen.url) || Math.abs(now() - Number(seen.time)) > windowMs) return false;
    if (!sameHex(seen.mac, macOf(key, `announce\n${seen.id}\n${seen.url}\n${seen.time}`))) return false;
    known.set(seen.url, { id: seen.id, until_ms: now() + config.announce.ttl_seconds * 1000 });
    return true;
  }
  const live = () => [...known].filter(([url, row]) => row.until_ms > now() && (cooling.get(url) ?? 0) <= now()).map(([url]) => url);

  /** Starts listening for and sending announcements; the returned function stops both. */
  function announce(advertiseUrl) {
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('message', message => { heard(message); });
    socket.on('error', error => log({ peer_announce_failed: String(error.message ?? error) }));
    let timer = null;
    const ready = new Promise(resolve => socket.bind(config.announce.port, () => {
      try { socket.setBroadcast(true); } catch { /* a loopback target needs no broadcast */ }
      const send = () => { if (advertiseUrl) for (const to of config.announce.to) socket.send(announcement(advertiseUrl), config.announce.port_to ?? config.announce.port, to, () => {}); };
      send();
      timer = setInterval(send, config.announce.every_seconds * 1000);
      timer.unref?.();
      resolve();
    }));
    return { ready, port: () => socket.address().port, stop: () => { clearInterval(timer); try { socket.close(); } catch { /* already closed */ } } };
  }

  // ---- fetching a whole file from a peer -----------------------------------------------------------------------------
  /** Writes the file to `dest` from the first peer that sends bytes whose BLAKE3 is `identity`; the peer's url, or null. */
  async function fetchWhole({ identity, length, dest, signal }) {
    if (!IDENTITY.test(identity) || !Number.isSafeInteger(length) || length <= 0 || length > config.max_file_bytes) return null;
    for (const url of live()) {
      const target = `/peer/file/${identity}?length=${length}`;
      const controller = new AbortController();
      const stop = () => controller.abort();
      signal?.addEventListener('abort', stop, { once: true });
      const timer = setTimeout(stop, config.timeout_ms);
      let accepted = false;
      try {
        const answer = await fetchImpl(`${url}${target}`, { headers: signed('GET', target), signal: controller.signal, redirect: 'error' });
        if (answer.status === 404) { void answer.body?.cancel().catch(() => {}); continue; }
        if (!answer.ok || !answer.body) throw new Error(`The peer answered ${answer.status}.`);
        const hasher = makeHashCodeHasher();
        let received = 0;
        const out = createWriteStream(dest);
        try {
          for await (const piece of answer.body) {
            received += piece.byteLength;
            if (received > length) throw new Error('The peer sent more than the file.');
            hasher.update(piece);
            if (!out.write(piece)) await new Promise(resolve => out.once('drain', resolve));
          }
        } finally { await new Promise(resolve => out.end(resolve)); }
        if (received !== length || hasher.identity() !== identity) throw Object.assign(new Error('The bytes are not the file named.'), { bad: true });
        accepted = true;
        return url;
      } catch (error) {
        if (signal?.aborted) return null;
        log({ peer_fetch_failed: url, error: String(error.message ?? error) });
        cooling.set(url, now() + config.bad_peer_seconds * 1000);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        if (!accepted) await fs.rm(dest, { force: true });
      }
    }
    return null;
  }

  return { signed, verify, announce, heard, announcement, fetchWhole, live, forget: url => known.delete(url) };
}
