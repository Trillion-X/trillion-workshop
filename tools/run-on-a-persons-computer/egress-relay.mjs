// computer/egress-relay.mjs
//
// Purpose
//   Opt-in "use my connection": a cloud AI's network streams are relayed through this Mac over one authenticated
//   WebSocket, so a tool that is only reachable from the person's own network works with their machine and their consent.
//
// Non-negotiable invariants
//   1. Off unless computer/egress-relay.json `on` is true. Which addresses are refused, which hosts are allowed, the buffer
//      limit and the timing are that DATA; this file names no host, range or service.
//   2. Every name is resolved first and the policy is checked on the resolved address, which is then the address
//      connected to (the name is never resolved again, so a name that changes its answer cannot move a stream onto a
//      private address). An unresolvable name, or any of its addresses being private or reserved, refuses the stream.
//   3. One link has one owner: attaching as `claim` takes the link from another computer, attaching as `if-free` stands
//      by when another computer holds it, retrying on the standby schedule; a link that goes silent is reset.
//   4. A refused stream is closed with a close frame for that stream; the link and its other streams carry on.
//   5. Backpressure: a stream's socket is paused while the link holds more than max_buffer_bytes unsent and resumed when it
//      drains, so one stuck stream cannot buffer without bound.
//   6. The key is sent only as a bearer header, never in the address, a frame or a log.
import { lookup } from 'node:dns/promises';
import { createConnection, isIP } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const egressRelaySettings = () => JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'egress-relay.json'), 'utf8'));
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

// ---- addresses -------------------------------------------------------------------------------------------------
const ipv4Number = text => text.split('.').reduce((total, part) => total * 256 + Number(part), 0);
function ipv6Words(text) {
  const [head, tail = null] = text.split('::');
  const side = part => (part === '' ? [] : part.split(':'));
  const left = side(head), right = tail === null ? [] : side(tail);
  const words = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return words.map(word => parseInt(word || '0', 16));
}
function bigOf(address) {
  if (isIP(address) === 4) return { bits: 32, value: BigInt(ipv4Number(address)) };
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return { bits: 32, value: BigInt(ipv4Number(mapped[1])) };
  return { bits: 128, value: ipv6Words(address).reduce((total, word) => (total << 16n) | BigInt(word), 0n) };
}
function inRange(address, cidr) {
  const [base, length] = cidr.split('/');
  const a = bigOf(address), b = bigOf(base);
  if (a.bits !== b.bits) return false;
  const shift = BigInt(a.bits - Number(length));
  return (a.value >> shift) === (b.value >> shift);
}

/** The blocked range holding `address`: { cidr, why }, or null when the address is public. */
export function blockedRange(address, settings = egressRelaySettings()) {
  return settings.blocked_ranges.find(row => inRange(address, row.cidr)) ?? null;
}

/**
 * Whether a stream to host:port may open: { ok: true, address } (the address to connect to) or { ok: false, why }.
 * `resolve(host)` → [{ address }] (dns.lookup all by default).
 */
export async function decideOpen({ host, port }, settings = egressRelaySettings(), resolve = name => lookup(name, { all: true })) {
  if (settings.allowed_hosts.length && !settings.allowed_hosts.some(allowed => host === allowed || host.endsWith(`.${allowed}`))) return { ok: false, why: fill(settings.words.host_not_allowed, { host }) };
  const found = isIP(host) ? [{ address: host }] : await Promise.resolve(resolve(host)).catch(() => []);
  if (!found.length) return { ok: false, why: fill(settings.words.unresolved, { host }) };
  if (settings.allow_private_targets !== true) {
    for (const { address } of found) {
      const range = blockedRange(address, settings);
      if (range) return { ok: false, why: fill(settings.words.private_target, { host, why: range.why }) };
    }
  }
  return { ok: true, address: found[0].address, port };
}

// ---- frames ----------------------------------------------------------------------------------------------------
/** open: stream id, port, host; data: stream id, bytes; close: stream id. One byte of kind, four of stream id. */
export function encodeFrame(kind, stream, body, settings = egressRelaySettings()) {
  const head = Buffer.alloc(5);
  head.writeUInt8(kind, 0);
  head.writeUInt32BE(stream, 1);
  if (kind === settings.frames.open) {
    const port = Buffer.alloc(2); port.writeUInt16BE(body.port, 0);
    return Buffer.concat([head, port, Buffer.from(body.host, 'utf8')]);
  }
  return kind === settings.frames.data ? Buffer.concat([head, Buffer.from(body)]) : head;
}
export function decodeFrame(bytes, settings = egressRelaySettings()) {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 5) return null;
  const kind = buffer.readUInt8(0), stream = buffer.readUInt32BE(1);
  if (kind === settings.frames.open) return buffer.length < 8 ? null : { kind, stream, port: buffer.readUInt16BE(5), host: buffer.subarray(7).toString('utf8') };
  if (kind === settings.frames.data) return { kind, stream, bytes: buffer.subarray(5) };
  return kind === settings.frames.close ? { kind, stream } : null;
}

// ---- the link --------------------------------------------------------------------------------------------------
/**
 * The relay for one link. `connect(headers)` → a WebSocket-like object (binaryType, send, close, bufferedAmount and
 * addEventListener for open / message / close / error). Returns { start, stop, state }.
 */
export function makeEgressRelay({ connect, attach = 'claim', client = 'this-mac', settings = egressRelaySettings(), resolve, open = createConnection, log = () => {}, timers = { setTimeout, clearTimeout }, now = Date.now }) {
  const streams = new Map();
  let socket = null, stopped = false, lastFrame = 0, silence = null, retry = null, attempts = 0, claimed = attach === settings.attach.claim;
  let mode = attach;
  const state = { link: 'down', streams: 0, refused: 0 };
  const send = bytes => { try { socket.send(bytes); } catch (error) { log({ egress_send_failed: String(error.message ?? error) }); } };
  const closeStream = (id, tellBox = true) => {
    const stream = streams.get(id);
    if (stream) { stream.destroy(); streams.delete(id); state.streams = streams.size; }
    if (tellBox) send(encodeFrame(settings.frames.close, id, null, settings));
  };
  const onFrame = async frame => {
    if (frame.kind === settings.frames.open) {
      if (streams.size >= settings.max_streams) { state.refused += 1; return send(encodeFrame(settings.frames.close, frame.stream, null, settings)); }
      const decision = await decideOpen(frame, settings, resolve);
      if (!decision.ok) { state.refused += 1; log({ egress_refused: decision.why }); return closeStream(frame.stream); }
      const tcp = open({ host: decision.address, port: decision.port });
      streams.set(frame.stream, tcp); state.streams = streams.size;
      tcp.on('data', chunk => {
        send(encodeFrame(settings.frames.data, frame.stream, chunk, settings));
        if (socket.bufferedAmount > settings.max_buffer_bytes) {
          tcp.pause();
          const resume = () => { if (socket && socket.bufferedAmount <= settings.max_buffer_bytes) tcp.resume(); else timers.setTimeout(resume, settings.drain_check_ms); };
          timers.setTimeout(resume, settings.drain_check_ms);
        }
      });
      tcp.on('close', () => { if (streams.get(frame.stream) === tcp) closeStream(frame.stream); });
      tcp.on('error', () => { if (streams.get(frame.stream) === tcp) closeStream(frame.stream); });
    } else if (frame.kind === settings.frames.data) streams.get(frame.stream)?.write(frame.bytes);
    else closeStream(frame.stream, false);
  };
  const dropAll = () => { for (const id of [...streams.keys()]) closeStream(id, false); };
  const watch = () => {
    timers.clearTimeout(silence);
    silence = timers.setTimeout(() => { if (now() - lastFrame >= settings.silence_ms) { log({ egress_stale_reset: true }); reconnect(claimed ? settings.attach.claim : settings.attach.if_free); } else watch(); }, settings.silence_ms);
  };
  function reconnect(next) {
    mode = next;
    try { socket?.close(); } catch { /* already gone */ }
    dropAll();
    begin();
  }
  function standBy() {
    if (stopped) return;
    const wait = settings.standby_ms[Math.min(attempts, settings.standby_ms.length - 1)];
    attempts += 1;
    retry = timers.setTimeout(begin, wait);
  }
  function begin() {
    if (stopped) return;
    state.link = 'connecting';
    socket = connect({ [settings.attach.header]: mode, [settings.attach.client_header]: client });
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('open', () => { state.link = 'up'; attempts = 0; lastFrame = now(); if (mode === settings.attach.claim) claimed = true; watch(); });
    socket.addEventListener('message', event => { lastFrame = now(); const frame = decodeFrame(event.data, settings); if (frame) onFrame(frame).catch(error => log({ egress_frame_failed: String(error.message ?? error) })); });
    socket.addEventListener('close', event => {
      timers.clearTimeout(silence); dropAll();
      if (stopped) { state.link = 'down'; return; }
      const taken = event.code === settings.attach.occupied_code || event.code === settings.attach.replaced_code;
      state.link = taken ? 'standby' : 'down';
      if (taken) { claimed = false; mode = settings.attach.if_free; }
      standBy();
    });
    socket.addEventListener('error', () => { /* the close that follows decides what happens next */ });
  }
  return {
    state,
    start: () => { stopped = false; begin(); },
    stop: () => { stopped = true; timers.clearTimeout(silence); timers.clearTimeout(retry); try { socket?.close(); } catch { /* already gone */ } dropAll(); state.link = 'down'; },
  };
}
