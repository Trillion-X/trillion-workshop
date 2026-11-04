// tools/listen-for-a-while/show/live-audio-stream.ts (moved from Trillion-X/trillion parts/record-audio/show/live-audio-stream.ts)
//
// Purpose
//   The live-words stream of record-in-the-browser.ts, made to survive a dropped connection and to say which codec it speaks.
//   Every chunk gets a sequence number and is kept in a bounded resend buffer; when the connection drops the stream opens a new one and
//   replays from the last confirmed turn minus a small overlap; a line the replay makes the route say twice is dropped by its normalised
//   words. The codec is a row of live-audio-stream.json (base codec, extra FEC percent, extra layers), chosen by what the browser, the
//   route and the adaptation ladder allow, and each choice is one structured line.
//
// Non-negotiable invariants
//   1. The resend buffer is bounded (resend.seconds of audio); the oldest chunk goes first, never the newest.
//   2. A chunk is confirmed only when a turn that began after it has ended; replay never starts later than the last confirmed chunk less the overlap.
//   3. A repeated line (same words, same channel) inside the remembered window is shown once.
//   4. Codecs, FEC and layers are DATA rows. A layered row is spoken only on the ladder's last rung and only when its layer is ready.
//   5. Reconnects are bounded (resend.most_reconnects); after that the caller is told the words stopped, as before.

import data from './live-audio-stream.json' with { type: 'json' };

export type CodecRow = (typeof data.codecs)[number];
export type StreamData = typeof data;
export type LayerState = keyof typeof data.layer_states;
export type CodecConditions = { browserHasOpus: boolean; routeAcceptsOpus: boolean; layerFlag: boolean; layerModelReady: boolean; rung: number };

/** off: no flag; enabled: flag on but the model is not ready; ready: both. */
export const layerState = (flag: boolean, modelReady: boolean): LayerState => (!flag ? 'off' : modelReady ? 'ready' : 'enabled');

/** The first enabled row whose needs hold; the last row of the table when none does (the base codec). */
export function chooseCodec(conditions: CodecConditions, rows: StreamData = data): CodecRow {
  const last = rows.ladder.length - 1;
  const state = layerState(conditions.layerFlag, conditions.layerModelReady);
  const holds = (row: CodecRow) => row.enabled
    && (!row.needs.browser_opus || conditions.browserHasOpus)
    && (!row.needs.route_opus || conditions.routeAcceptsOpus)
    && (!row.needs.layer_ready || state === 'ready')
    && (!('last_rung_only' in row && row.last_rung_only) || conditions.rung >= last);
  return rows.codecs.find(holds) ?? rows.codecs[rows.codecs.length - 1];
}

/** The one structured line that says what a stream speaks: codec, layers, FEC, bitrate and why. */
export function codecLine(row: CodecRow, conditions: CodecConditions, rows: StreamData = data): string {
  return JSON.stringify({
    codec: row.id, layers: row.layers, fec_extra_percent: row.fec_extra_percent, bitrate_kbps: row.bitrate_kbps,
    rung: rows.ladder[Math.min(conditions.rung, rows.ladder.length - 1)], layer: layerState(conditions.layerFlag, conditions.layerModelReady),
  });
}

const normal = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

/** Remembers the last lines said per channel; `fresh` is false for a line already shown. */
export function createDuplicateDrop(remember: number = data.duplicates.remember) {
  const seen: string[] = [];
  return {
    fresh(channel: string, text: string): boolean {
      const key = `${channel}\u0000${normal(text)}`;
      if (!normal(text)) return true;
      if (seen.includes(key)) return false;
      seen.push(key);
      if (seen.length > remember) seen.shift();
      return true;
    },
  };
}

export type SocketLike = { readyState: number; bufferedAmount: number; send(bytes: ArrayBufferLike): void; close(): void };
type Kept = { sequence: number; bytes: ArrayBufferLike };

/**
 * The stream: chunks go out numbered, are kept for replay, and a lost connection is replaced and caught up.
 * `open` makes a fresh connection (the caller wires its message handler to `heard`); `isOpen` says a socket can take bytes.
 */
export function createLiveStream(options: {
  open: () => SocketLike; isOpen: (socket: SocketLike) => boolean; chunkSeconds: number; conditions: CodecConditions;
  encode?: (chunk: Float32Array, row: CodecRow) => ArrayBufferLike | null; onLine?: (line: string) => void; rows?: StreamData;
  schedule?: (run: () => void, ms: number) => void;
}) {
  const rows = options.rows ?? data;
  const keep = Math.max(1, Math.round(rows.resend.seconds / options.chunkSeconds));
  const buffer: Kept[] = [];
  const duplicates = createDuplicateDrop(rows.duplicates.remember);
  const schedule = options.schedule ?? ((run: () => void, ms: number) => { setTimeout(run, ms); });
  let socket: SocketLike | null = null;
  let sequence = 0;
  let confirmed = -1;
  let turnStart: number | null = null;
  let tries = 0;
  let chosen = chooseCodec(options.conditions, rows);
  options.onLine?.(codecLine(chosen, options.conditions, rows));

  const raw = (chunk: Float32Array): ArrayBufferLike => {
    const bytes = options.encode?.(chunk, chosen);
    if (bytes) return bytes;
    const out = new Int16Array(chunk.length);
    for (let index = 0; index < chunk.length; index += 1) out[index] = Math.round(Math.max(-1, Math.min(1, chunk[index])) * 32767);
    return out.buffer;
  };
  const connect = () => { socket = options.open(); return socket; };

  return {
    codec: () => chosen,
    sequence: () => sequence,
    buffered: () => buffer.length,
    connect,
    /** Moves down or up the adaptation ladder; the codec row and its line are chosen again. */
    setRung(rung: number) {
      options.conditions = { ...options.conditions, rung };
      const next = chooseCodec(options.conditions, rows);
      if (next.id !== chosen.id) { chosen = next; options.onLine?.(codecLine(next, options.conditions, rows)); }
    },
    /** Numbers a chunk, keeps it for replay and sends it when a connection can take it. */
    push(chunk: Float32Array) {
      const bytes = raw(chunk);
      buffer.push({ sequence, bytes });
      sequence += 1;
      while (buffer.length > keep) buffer.shift();
      if (socket && options.isOpen(socket)) socket.send(bytes);
    },
    /** What the route said: true when it should be shown (a replay's repeat of a line already shown is not). */
    heard(event: { event?: string; transcript?: string; channel?: string }): boolean {
      if (event.event === 'StartOfTurn') turnStart = sequence;
      if (event.event === 'EndOfTurn') {
        if (turnStart != null) confirmed = Math.max(confirmed, turnStart - 1);
        turnStart = null;
        return duplicates.fresh(event.channel ?? 'main', event.transcript ?? '');
      }
      return true;
    },
    /** The connection was lost: tries a new one and replays from the last confirmed chunk less the overlap. False when it will not try again. */
    lost(onGiveUp: () => void): boolean {
      if (tries >= rows.resend.most_reconnects) { onGiveUp(); return false; }
      tries += 1;
      schedule(() => {
        const next = connect();
        const from = Math.max(0, confirmed + 1 - rows.resend.overlap_chunks);
        const replay = buffer.filter(item => item.sequence >= from);
        const sendAll = () => { for (const item of replay) next.send(item.bytes); tries = 0; };
        if (options.isOpen(next)) sendAll(); else (next as SocketLike & { onopen?: () => void }).onopen = sendAll;
      }, rows.resend.reconnect_ms);
      return true;
    },
    close() { socket?.close(); socket = null; },
  };
}
