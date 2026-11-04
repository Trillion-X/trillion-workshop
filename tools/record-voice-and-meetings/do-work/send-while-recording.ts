// parts/record-audio/do-work/send-while-recording.ts
//
// NO PRIOR: searched parts/ and bitfield-packages/packages for a sender that streams a recording into a file
// while it is still being made ('length_known', 'growing', 'progressive upload', 'send while recording'); the only
// growing-file senders (parts/live-namespace/do-work/send-a-file-to-namespace-browser.mjs, src/phone-share.mjs) need
// the whole file and its length before they start.
//
// PURPOSE
//   Sends a recording into the person's Files while it is still being recorded, so the file can be found and read by
//   its name from its first piece. It sends only pieces the device already holds (recording-on-device.ts), in order,
//   into one growing file whose length is not known yet (src/namespace.mjs `length_known: false`, one request per span
//   of pieces). When the recording is closed and every piece has been sent, it finishes the file under the BLAKE3
//   identity of the device copy. A dropped connection or a busy service is waited out and sent again; an upload the
//   service no longer holds is started again from the device copy; a refusal stops and is said, and `retry` goes on.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A piece is sent only after the device stored it; nothing here reads a recording from memory.
//   2. Spans go in order and each is recorded in the device journal before it is sent, so a span sent again after a
//      reload carries the same pieces, the same bytes and the same number, which the service accepts as the same span.
//   3. Every state is recoverable from the journal alone: a page that reloads at any moment carries on from the first
//      span the service has not acknowledged, or from nothing when the service no longer holds the upload.
//   4. The file is finished only once the device copy is closed and every span was acknowledged, under the identity
//      of exactly the bytes on the device, so the kept file is the device copy byte for byte.
//   5. Nothing names a kind of recording or a screen: the namespace is reached through the client handed in.

import type { RecordingUpload, SentSpan } from './recorded-file-store';
import type { DeviceRecording } from './recording-on-device';

/** How a request to the person's Files went wrong: send it `again` later, `restart` the upload from the device copy,
 *  or `refused` (say why and stop until the person asks again). */
export type SendProblemKind = 'again' | 'restart' | 'refused';
export class SendProblem extends Error {
  readonly kind: SendProblemKind;
  constructor(kind: SendProblemKind, message: string) { super(message); this.name = 'SendProblem'; this.kind = kind; }
}

/** The person's Files, as the sender needs them. Each call throws a SendProblem when it does not go through. */
export type GrowingClient = {
  /** Starts a file named `name` whose length is not known yet; answers its upload id. */
  start: (input: { name: string; media_type: string; modified_at_ms: number }) => Promise<string>;
  /** Adds span `piece` (numbered from 0) starting at byte `offset`. Sending the same span again changes nothing. */
  piece: (upload: string, input: { piece: number; offset: number; bytes: Uint8Array }) => Promise<void>;
  /** Finishes the file at `byte_length` bytes under `identity`; answers the identity it is kept under. */
  finish: (upload: string, input: { identity: string; byte_length: number }) => Promise<string>;
  /** Throws the upload away (its name goes, its room is given back). */
  cancel: (upload: string) => Promise<void>;
  /** The content identity of these bytes in order. */
  identity: (pieces: Blob[]) => Promise<string>;
};

/** What the screen shows about the sending. `sent` is the bytes the service acknowledged; `waiting` means the last try
 *  failed in passing and is being tried again; `problem` is a refusal in the service's words. */
export type SendState = { sent: number; kept: string | null; waiting: boolean; problem: string | null; empty: boolean };

export type Sending = {
  state: () => SendState;
  onChange: (listener: () => void) => () => void;
  /** Resolves with the identity once the closed recording is kept; rejects with the refusal if one comes first. */
  whenKept: () => Promise<string>;
  /** Goes on after a refusal, or tries again at once after a failure in passing (the connection came back). */
  retry: () => void;
  /** Stops sending from this page; the device copy and the journal stay, so it goes on later. */
  stop: () => void;
  /** Stops sending and throws the upload away (the recording was discarded). */
  cancel: () => Promise<void>;
};

// A span carries at most this many bytes, well under what one request may carry.
const SPAN_BYTES = 8 * 1024 * 1024;
// Waits before trying again after a failure in passing, one per try; the last repeats.
const AGAIN_MS = [1000, 2000, 4000, 8000, 15000, 30000];

const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

export type SendOptions = { spanBytes?: number; againMs?: number[]; wait?: (ms: number, woken: Promise<void>) => Promise<void> };

/** Starts sending `recording` into the file `name` and keeps sending until it is kept, stopped or cancelled. */
export function sendWhileRecording(recording: DeviceRecording, client: GrowingClient, name: string, options: SendOptions = {}): Sending {
  const spanBytes = options.spanBytes ?? SPAN_BYTES;
  const againMs = options.againMs ?? AGAIN_MS;
  const wait = options.wait ?? ((ms, woken) => Promise.race([sleep(ms), woken]));
  let state: SendState = { sent: 0, kept: recording.upload()?.kept ?? null, waiting: false, problem: null, empty: false };
  let stopped = false;
  let failures = 0;
  const listeners = new Set<() => void>();
  const keptWaiters: { resolve: (identity: string) => void; reject: (error: Error) => void }[] = [];
  const set = (next: Partial<SendState>) => { state = { ...state, ...next }; for (const listener of listeners) listener(); };
  // One promise the loop sleeps on, settled by any change worth waking for (a piece stored, the close, retry, stop).
  let wake: () => void = () => {};
  let woken = new Promise<void>(done => { wake = done; });
  const rouse = () => { const done = wake; woken = new Promise<void>(next => { wake = next; }); done(); };
  const unhear = recording.onChange(rouse);

  const upload = (): RecordingUpload => recording.upload() ?? { name, growing: null, spans: [], kept: null };
  // Spans are acknowledged in order, so the bytes acknowledged end where the last acknowledged span ends. The journal
  // keeps only that span and any not yet acknowledged, so it stays small however long the recording runs.
  const acknowledged = (spans: SentSpan[]) => spans.reduce((end, span) => (span.sent ? Math.max(end, span.offset + span.length) : end), 0);
  const trimmed = (spans: SentSpan[]) => {
    const lastSent = spans.filter(span => span.sent).pop();
    return spans.filter(span => !span.sent || span === lastSent);
  };
  set({ sent: acknowledged(upload().spans) });

  const sendSpan = async (current: RecordingUpload, span: SentSpan) => {
    const pieces = await recording.pieces(span.from, span.to);
    const bytes = new Uint8Array(await new Blob(pieces).arrayBuffer());
    await client.piece(current.growing as string, { piece: span.ordinal, offset: span.offset, bytes });
    const spans = trimmed(current.spans.map(each => (each.ordinal === span.ordinal ? { ...each, sent: true } : each)));
    await recording.setUpload({ ...current, spans });
    set({ sent: acknowledged(spans) });
  };

  // The next span: every stored piece after the last span, up to the span size (at least one piece).
  const nextSpan = async (current: RecordingUpload): Promise<SentSpan | null> => {
    const last = current.spans[current.spans.length - 1];
    const from = last ? last.to + 1 : 0;
    const stored = recording.stored();
    if (from >= stored) return null;
    const pieces = await recording.pieces(from, stored - 1);
    let length = 0;
    let count = 0;
    for (const piece of pieces) {
      if (count > 0 && length + piece.size > spanBytes) break;
      length += piece.size;
      count += 1;
    }
    return { ordinal: last ? last.ordinal + 1 : 0, from, to: from + count - 1, offset: last ? last.offset + last.length : 0, length, sent: false };
  };

  const step = async (): Promise<'again' | 'wait' | 'done'> => {
    let current = upload();
    if (current.kept) return 'done';
    if (!current.growing) {
      // Nothing is named in Files before there is something to read.
      if (!recording.stored()) {
        if (recording.closed()) { set({ empty: true }); return 'done'; }
        return 'wait';
      }
      const growing = await client.start({ name, media_type: recording.mediaType, modified_at_ms: recording.startedAt.getTime() });
      current = { name, growing, spans: [], kept: null };
      await recording.setUpload(current);
    }
    const unsent = current.spans.find(span => !span.sent);
    if (unsent) { await sendSpan(current, unsent); return 'again'; }
    const span = await nextSpan(current);
    if (span) {
      current = { ...current, spans: [...current.spans, span] };
      await recording.setUpload(current);
      await sendSpan(current, span);
      return 'again';
    }
    if (!recording.closed()) return 'wait';
    const pieces = await recording.pieces(0, recording.stored() - 1);
    const identity = await client.identity(pieces);
    const kept = await client.finish(current.growing as string, { identity, byte_length: acknowledged(current.spans) });
    await recording.setUpload({ ...current, kept });
    set({ kept });
    return 'done';
  };

  const settle = () => {
    if (state.kept) for (const waiter of keptWaiters.splice(0)) waiter.resolve(state.kept);
    else if (state.empty) for (const waiter of keptWaiters.splice(0)) waiter.reject(new Error('This recording is empty. Record again and press Done when you finish.'));
    else if (state.problem) for (const waiter of keptWaiters.splice(0)) waiter.reject(new Error(state.problem));
  };

  const run = async () => {
    while (!stopped) {
      if (recording.failed()) {
        set({ problem: 'This device could not keep the rest of the recording, so it stops where the device kept it.' });
      }
      if (state.problem) { settle(); const asleep = woken; await asleep; continue; }
      let next: 'again' | 'wait' | 'done';
      const asleep = woken;
      try {
        next = await step();
        failures = 0;
        if (state.waiting) set({ waiting: false });
      } catch (error) {
        const problem = error instanceof SendProblem ? error : new SendProblem('again', error instanceof Error ? error.message : String(error));
        if (problem.kind === 'refused') { set({ problem: problem.message, waiting: false }); continue; }
        if (problem.kind === 'restart') {
          // The service no longer holds this upload (or holds other bytes under its numbers): start it again from the
          // device copy; chunks it already holds are not stored twice.
          await recording.setUpload({ name, growing: null, spans: [], kept: null });
          set({ sent: 0 });
          await wait(againMs[Math.min(failures, againMs.length - 1)], asleep);
          failures += 1;
          continue;
        }
        set({ waiting: true });
        await wait(againMs[Math.min(failures, againMs.length - 1)], asleep);
        failures += 1;
        continue;
      }
      if (next === 'done') { settle(); return; }
      if (next === 'wait') await asleep;
    }
  };
  void run();

  return {
    state: () => state,
    onChange: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    whenKept: () => new Promise<string>((resolve, reject) => { keptWaiters.push({ resolve, reject }); settle(); }),
    retry: () => { if (state.problem) set({ problem: null }); failures = 0; rouse(); },
    stop: () => { stopped = true; unhear(); rouse(); },
    cancel: async () => {
      stopped = true;
      unhear();
      rouse();
      const growing = recording.upload()?.growing;
      if (growing && !recording.upload()?.kept) await client.cancel(growing).catch(() => undefined);
    },
  };
}
