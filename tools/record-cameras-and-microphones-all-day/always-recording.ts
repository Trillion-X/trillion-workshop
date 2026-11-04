// parts/record-audio/do-work/always-recording.ts
//
// NO PRIOR: searched parts/ and ~/dev/bitfield-packages/packages for a recorder that runs several inputs at once and
// never stops ("always on", "multi camera", "several cameras", "rolling", "continuous recording"); every recorder here
// makes one recording from one source that ends when it is stopped. This stands on those pieces instead of beside
// them: the one recorder (../show/record-in-the-browser.ts startCapture), the device copy (recording-on-device.ts) and
// the sender that sends while recording (send-while-recording.ts).
//
// PURPOSE
//   Records any number of inputs at once (cameras, each with or without a sound, and microphones) without end, cut on
//   the clock into pieces that each play on their own (rolling-segments.mjs). Every piece is kept on this device as it
//   is made and sent into the person's files while it is still being recorded, so nothing is lost when a connection,
//   a page or an input drops: an input that stops (unplugged, taken by another app) is opened again by itself every
//   `reopen_after_ms`, an input the caller says is paused stops recording and lets its device go until it is not, and
//   a list of every piece of every input (rolling-segments.mjs sessionList) is kept beside them after each piece.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a device, a screen, an app or a place: inputs, sources, folders and sizes are the caller's
//      DATA, the files are reached through the client handed in.
//   2. Every input's next piece starts before its last one stops, so no moment falls between two pieces.
//   3. A piece is kept on the device before it is sent (recording-on-device.ts); a piece whose sending could not
//      finish stays on the device, marked as this recorder's (`keptWith.feed`), and `sendLeftOver` finishes it later.
//   4. One input failing never stops another: each is opened, cut and kept on its own.

import { extensionOf, problemWords, startCapture, captureSource, openSource, type Capture, type CaptureSource } from '../show/record-in-the-browser';
import { keepOnDevice, reopenOnDevice, unfinishedRecordings, type DeviceRecording } from './recording-on-device';
import { sendWhileRecording, type GrowingClient, type Sending } from './send-while-recording';
import { pieceName, sessionList, windowAt } from './rolling-segments.mjs';
import type { DevicePick } from '../../permission-lease/read-data/capability-permission';

/** One input: a camera (its own sound by device id, or none) or a microphone. */
export type FeedInput = { id: string; kind: 'camera' | 'microphone'; device: string; sound: string | null; name: string };
export type FeedState = 'starting' | 'recording' | 'paused' | 'reconnecting';
export type FeedStatus = { input: FeedInput; state: FeedState; problem: string; stream: MediaStream | null; kept: number; sent: number; waiting: boolean; since: number };

export type FeedSettings = {
  folder: string;
  segment_seconds: number;
  sources: Record<FeedInput['kind'], string>;
  video_quality: Record<string, unknown>;
  reopen_after_ms: number;
  list_name: string;
};

export type FeedOptions = {
  settings: FeedSettings;
  inputs: FeedInput[];
  client: GrowingClient;
  /** Keeps the session's list of pieces under a name, replacing what was there. */
  keepList: (name: string, text: string) => Promise<unknown>;
  account: string | null;
  /** Which device made the recording, as a person reads it (kept in the list). */
  device: string;
  /** Whether an input is paused now (asked every second). */
  paused: (input: FeedInput) => boolean;
  now?: () => number;
};

type Piece = { startMs: number; capture: Capture; device: DeviceRecording; sending: Sending; folder: string; name: string };
type Run = { status: FeedStatus; source: CaptureSource; piece: Piece | null; tryAgainAt: number; busy: boolean };

export type AlwaysRecording = {
  startedMs: number;
  statuses: () => FeedStatus[];
  onChange: (listener: () => void) => () => void;
  /** Stops every input, keeps every last piece, and answers once all of them are sent. */
  stop: () => Promise<void>;
};

const FEED = 'always-recording-piece';

/** Opens one input's stream as its DATA says: its camera with its own sound or none, or its microphone. */
function pickOf(input: FeedInput, settings: FeedSettings): DevicePick {
  return input.kind === 'camera'
    ? { video: input.device, audio: input.sound ?? false, video_quality: settings.video_quality }
    : { audio: input.device };
}

export function startAlwaysRecording(options: FeedOptions): AlwaysRecording {
  const { settings, client, keepList, account } = options;
  const now = options.now ?? Date.now;
  const startedMs = now();
  const listeners = new Set<() => void>();
  const tell = () => { for (const listener of [...listeners]) listener(); };
  const kept: { input: string; start_ms: number; end_ms: number; file: string; identity: string }[] = [];
  const listName = pieceName({ folder: settings.folder, startMs: startedMs, input: settings.list_name, extension: 'json' });
  let stopping = false;
  let stopped: Promise<void> | null = null;
  const pending = new Set<Promise<void>>();
  const problems: unknown[] = [];
  const completions = new WeakMap<Piece, Promise<void>>();
  const localPieces = new Set<DeviceRecording>();
  const join = (work: Promise<void>) => {
    const held = work.catch(error => { problems.push(error); }).finally(() => pending.delete(held));
    pending.add(held);
    return held;
  };
  let windowEnd = windowAt(startedMs, settings.segment_seconds).end;

  const runs: Run[] = options.inputs.map(input => {
    const source = captureSource(settings.sources[input.kind]);
    if (!source) throw new Error(`Recording from a ${input.kind} is not set up on this device.`);
    return { status: { input, state: 'starting', problem: '', stream: null, kept: 0, sent: 0, waiting: false, since: startedMs }, source, piece: null, tryAgainAt: 0, busy: false };
  });
  const set = (run: Run, next: Partial<FeedStatus>) => { run.status = { ...run.status, ...next }; tell(); };

  const listText = () => `${JSON.stringify(sessionList({
    startedMs, segmentSeconds: settings.segment_seconds, device: options.device,
    inputs: runs.map(run => ({ name: run.status.input.name, kind: run.status.input.kind, with_sound: run.status.input.kind === 'microphone' || Boolean(run.status.input.sound) })),
    pieces: kept,
  }), null, 2)}\n`;
  // One list write at a time. Every input's piece ends at the same instant, so they all ask together; written at once
  // the store refused all but one (409) and the list kept could name fewer pieces than were kept. A write asked for
  // while one is under way is folded into one more write afterwards, made from every piece kept by then.
  let indexWriting: Promise<void> = Promise.resolve();
  let listWriting: Promise<void> | null = null;
  let listAgain = false;
  const writeList = (): Promise<void> => {
    if (listWriting) { listAgain = true; return listWriting; }
    listWriting = (async () => {
      do {
        listAgain = false;
        await keepList(`${listName.folder}/${listName.name}`, listText());
      } while (listAgain);
    })().finally(() => { listWriting = null; });
    return listWriting;
  };

  /** Starts the input's next piece from its open stream (a copy of it, so stopping the piece leaves the input open). */
  async function beginPiece(run: Run): Promise<Piece> {
    const stream = run.status.stream as MediaStream;
    const held: Blob[] = [];
    let device: DeviceRecording | null = null;
    const capture = await startCapture(run.source, {
      stream: stream.clone(),
      onPiece: piece => { if (device) void device.add(piece); else held.push(piece); },
      onEnded: () => { lost(run); },
    });
    const startMs = capture.startedAt.getTime();
    const named = pieceName({ folder: settings.folder, startMs, input: run.status.input.name, extension: extensionOf(run.source, capture.mediaType) });
    device = keepOnDevice({
      id: `${FEED}:${run.status.input.id}:${startMs}`, name: named.name, mediaType: capture.mediaType, startedAt: capture.startedAt, account,
      keptWith: { feed: true, folder: named.folder, input: run.status.input.name, start_ms: startMs,
        session: { name: `${listName.folder}/${listName.name}`, startedMs, segmentSeconds: settings.segment_seconds, device: options.device,
          inputs: runs.map(each => ({ name: each.status.input.name, kind: each.status.input.kind, with_sound: each.status.input.kind === 'microphone' || Boolean(each.status.input.sound) })) } },
    });
    for (const piece of held.splice(0)) void device.add(piece);
    localPieces.add(device);
    const sending = sendWhileRecording(device, client, `${named.folder}/${named.name}`);
    // What the sending says shows on the input: bytes sent, a wait for the connection, or a refusal in the service's words.
    sending.onChange(() => {
      const state = sending.state();
      if (run.piece?.sending === sending) set(run, { sent: state.sent, waiting: state.waiting, ...(state.problem ? { problem: state.problem } : {}) });
    });
    return { startMs, capture, device, sending, folder: named.folder, name: named.name };
  }

  /** Stops a piece, keeps it whole on the device, and once the person's files hold it lets the device copy go. */
  function finishPiece(run: Run, piece: Piece): Promise<void> {
    const existing = completions.get(piece);
    if (existing) return existing;
    const work = (async () => {
    try {
      const recorded = await piece.capture.stop();
      piece.device.setSeconds(recorded.seconds);
      await piece.device.close();
      const identity = await piece.sending.whenKept();
      kept.push({ input: run.status.input.name, start_ms: piece.startMs, end_ms: piece.startMs + Math.round(recorded.seconds * 1000), file: `${piece.folder}/${piece.name}`, identity });
      // The remote file and the secondary session list are independent saves. Retain a durable full list snapshot
      // beside this piece until both succeed, so recovery can restore the index without recording/uploading again.
      const indexWork = indexWriting.catch(() => undefined).then(async () => {
        const snapshot = listText();
        for (const device of localPieces) await device.setKeptWith({ ...device.keptWith() as object, session_text: snapshot });
        set(run, { kept: run.status.kept + 1 });
        await writeList();
        await piece.device.forget();
        localPieces.delete(piece.device);
      });
      indexWriting = indexWork;
      await indexWork;
    } catch (error) {
      // Refused or out of reach: the piece stays on this device and is sent when this recorder next starts.
      piece.sending.stop();
      await piece.device.release().catch(() => undefined);
      set(run, { problem: problemWords(error, run.source) });
      throw error;
    }
    })();
    const held = join(work);
    completions.set(piece, held);
    return held;
  }

  function lost(run: Run) {
    if (stopping || run.status.state === 'paused') return;
    const piece = run.piece;
    run.piece = null;
    for (const track of run.status.stream?.getTracks() ?? []) track.stop();
    set(run, { state: 'reconnecting', stream: null, problem: `${run.status.input.name} stopped. Trillion keeps trying to open it again.` });
    run.tryAgainAt = now() + settings.reopen_after_ms;
    if (piece) void finishPiece(run, piece);
  }

  async function open(run: Run) {
    run.busy = true;
    try {
      const stream = await openSource(run.source, pickOf(run.status.input, settings));
      if (stopping) { for (const track of stream.getTracks()) track.stop(); return; }
      set(run, { stream, problem: '' });
      const piece = await beginPiece(run);
      if (stopping) { await finishPiece(run, piece); return; }
      run.piece = piece;
      set(run, { state: 'recording', since: now() });
    } catch (error) {
      for (const track of run.status.stream?.getTracks() ?? []) track.stop();
      set(run, { state: 'reconnecting', stream: null, problem: problemWords(error, run.source) });
      run.tryAgainAt = now() + settings.reopen_after_ms;
    } finally {
      run.busy = false;
    }
  }

  async function pause(run: Run) {
    run.busy = true;
    const piece = run.piece;
    run.piece = null;
    for (const track of run.status.stream?.getTracks() ?? []) track.stop();
    set(run, { state: 'paused', stream: null, problem: '', since: now() });
    try { if (piece) await finishPiece(run, piece); } finally { run.busy = false; }
  }

  /** Every input cuts to its next piece at the same instant: the next starts, then the last stops. */
  async function cut(run: Run) {
    const last = run.piece;
    if (!last || !run.status.stream) return;
    run.busy = true;
    try {
      const next = await beginPiece(run);
      if (stopping) { run.piece = null; await finishPiece(run, next); await finishPiece(run, last); return; }
      run.piece = next;
      void finishPiece(run, last);
    } catch (error) {
      run.piece = last;
      set(run, { problem: problemWords(error, run.source) });
    } finally {
      run.busy = false;
    }
  }

  const tick = () => {
    if (stopping) return;
    const at = now();
    const cutting = at >= windowEnd;
    if (cutting) windowEnd = windowAt(at, settings.segment_seconds).end;
    for (const run of runs) {
      if (run.busy) continue;
      const paused = options.paused(run.status.input);
      if (paused && run.status.state !== 'paused') { void join(pause(run)); continue; }
      if (paused) continue;
      if (run.status.state === 'paused' || (run.status.state === 'reconnecting' && at >= run.tryAgainAt) || run.status.state === 'starting') { void join(open(run)); continue; }
      if (cutting && run.status.state === 'recording') void join(cut(run));
    }
  };
  const timer = setInterval(tick, 1000);
  tick();

  return {
    startedMs,
    statuses: () => runs.map(run => run.status),
    onChange: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    stop: () => {
      if (stopped) return stopped;
      stopping = true;
      clearInterval(timer);
      for (const run of runs) {
        const piece = run.piece;
        run.piece = null;
        if (piece) void finishPiece(run, piece);
        for (const track of run.status.stream?.getTracks() ?? []) track.stop();
        set(run, { state: 'paused', stream: null, waiting: true });
      }
      stopped = (async () => {
        while (pending.size) await Promise.all([...pending]);
        for (const run of runs) set(run, { waiting: false });
        if (problems.length) throw new AggregateError(problems, 'Recording stopped. Some pieces or their session details still need saving.');
      })();
      return stopped;
    },
  };
}

/** Whether a piece left on this device was made by this recorder (so other recorders leave it alone). */
export const isFeedPiece = (keptWith: unknown) => Boolean((keptWith as { feed?: unknown } | null)?.feed);

/** Sends every piece this recorder left on this device (its page closed while sending) under the name it was given,
 *  and lets each device copy go once the person's files hold it. Answers how many were sent. */
export async function sendLeftOver(account: string | null, client: GrowingClient, keepList?: FeedOptions['keepList']): Promise<number> {
  const found = (await unfinishedRecordings(account)).filter(item => isFeedPiece(item.keptWith));
  type Metadata = { folder: string; input?: string; start_ms?: number; session_text?: string; session?: { name: string; startedMs: number; segmentSeconds: number; device: string; inputs: unknown[] } };
  type Row = { input: string; start_ms: number; end_ms: number; file: string; identity: string };
  const groups = new Map<string, typeof found>();
  for (const item of found) {
    const metadata = item.keptWith as Metadata;
    const key = metadata.session?.name ?? item.id;
    groups.set(key, [...groups.get(key) ?? [], item]);
  }
  let sent = 0;
  const failures: unknown[] = [];
  for (const items of groups.values()) {
    const held: { device: DeviceRecording; sending: Sending; metadata: Metadata }[] = [];
    try {
      const pieces = new Map<string, Row>();
      for (const item of items) {
        const metadata = item.keptWith as Metadata;
        if (metadata.session_text) {
          const snapshot = JSON.parse(metadata.session_text);
          for (const moment of snapshot.moments ?? []) for (const file of moment.files ?? []) {
            pieces.set(file.file, { ...file, start_ms: moment.start_ms, end_ms: moment.end_ms });
          }
        }
        const device = reopenOnDevice(item);
        const sending = sendWhileRecording(device, client, item.upload?.name ?? `${metadata.folder}/${item.name}`);
        held.push({ device, sending, metadata });
        const identity = await sending.whenKept();
        const start = metadata.start_ms ?? item.startedAt.getTime();
        const own = { input: metadata.input ?? item.name, start_ms: start, end_ms: start + Math.round(item.seconds * 1000), file: item.upload?.name ?? `${metadata.folder}/${item.name}`, identity };
        pieces.set(own.file, own);
      }
      const session = held[0]?.metadata.session;
      if (session) {
        if (!keepList) throw new Error('The recording session list still needs saving.');
        const text = `${JSON.stringify(sessionList({ ...session, pieces: [...pieces.values()] }), null, 2)}\n`;
        // Persist the complete recovered group before retiring any copy. A later reload cannot lose an earlier
        // recovered piece merely because its own device copy was already removed.
        for (const { device, metadata } of held) await device.setKeptWith({ ...metadata, session_text: text });
        await keepList(session.name, text);
      }
      for (const { device } of held) { await device.forget(); sent += 1; }
    } catch (error) {
      failures.push(error);
    } finally {
      for (const { device, sending } of held) { sending.stop(); await device.release().catch(error => failures.push(error)); }
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Some recordings or their session details still need saving. Their device copies were kept.');
  return sent;
}
