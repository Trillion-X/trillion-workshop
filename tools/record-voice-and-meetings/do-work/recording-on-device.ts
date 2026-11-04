// parts/record-audio/do-work/recording-on-device.ts
//
// PORTED FROM: parts/record-audio/show/RecordAudioPanel.tsx (its per-piece storeRecordingChunkWithRetry, capture
// journal with an owner lease, and recovery of journals whose lease ran out), lifted out of that panel into one module
// any recorder screen calls, over the same store (recorded-file-store.ts).
//
// PURPOSE
//   A recording kept on this device first, piece by piece, while it is made. Each piece the recorder hands out is
//   written to the device before anything else may read it: the sender (send-while-recording.ts) only ever sends
//   pieces this file says are stored, so whatever reaches the person's Files is already safe on the device. The journal
//   says how far the recording is stored, whose it is, who is recording it now and how far it has been sent, so a
//   reload or a lost connection finds it again (`unfinishedRecordings`) and finishes it from the device copy.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pieces are stored strictly in the order they are handed in; `stored` counts a piece only once its write
//      finished, and every later piece waits for the one before it.
//   2. A piece that cannot be written after its retries stops the device copy with `failed` set; it is never skipped,
//      so the pieces on the device are always the recording's first `stored` pieces, with no gap.
//   3. While a tab holds a recording its lease is renewed; only a recording whose lease ran out (its tab closed or
//      reloaded) is offered by `unfinishedRecordings`, so a recording still being made elsewhere is never taken over.
//   4. A recording carries the account it belongs to; another account on the same device never finds it.
//   5. Every write goes through the store handed in (`DeviceStore`), so the same code runs on IndexedDB in a browser
//      and on a stand-in in a test.

import {
  captureJournalRecoveryState, forgetRecording, listCaptureJournals, readRecordingChunks, storeRecordingChunkWithRetry, writeCaptureJournal,
  type CaptureJournal, type RecordingUpload,
  storeRecordingPieceAndJournal,
} from './recorded-file-store';

/** Where a device recording's pieces and journal live: IndexedDB in a browser (`browserDeviceStore`). */
export type DeviceStore = {
  writePiece: (recordingId: string, sequence: number, mediaType: string, piece: Blob) => Promise<void>;
  writePieceAndJournal?: typeof storeRecordingPieceAndJournal;
  readPieces: (recordingId: string, from: number, to: number, mediaType: string) => Promise<Blob[]>;
  writeJournal: (journal: CaptureJournal) => Promise<void>;
  listJournals: () => Promise<CaptureJournal[]>;
  forget: (recordingId: string) => Promise<void>;
};

export const browserDeviceStore: DeviceStore = {
  writePiece: async (recordingId, sequence, mediaType, piece) => {
    await storeRecordingChunkWithRetry({ recordingId, sequence, mediaType, chunk: piece, observedAt: new Date().toISOString() });
  },
  readPieces: readRecordingChunks,
  writeJournal: writeCaptureJournal,
  writePieceAndJournal: storeRecordingPieceAndJournal,
  listJournals: listCaptureJournals,
  forget: forgetRecording,
};

// How long a recording stays held by the tab making it without a word from that tab, and how often it says so.
const LEASE_MS = 15_000;
const RENEW_MS = 5_000;

/** A recording found on this device that its tab never finished. */
export type UnfinishedRecording = {
  id: string; name: string; mediaType: string; startedAt: Date; seconds: number; stored: number;
  account: string | null; keptWith: unknown; upload: RecordingUpload | null;
};

export type DeviceRecording = {
  id: string;
  name: string;
  mediaType: string;
  startedAt: Date;
  /** How many pieces are safely on the device (pieces 0 .. stored - 1). */
  stored: () => number;
  /** How many bytes those pieces hold. */
  storedBytes: () => number;
  /** Set when a piece could not be written: the device copy stops there. */
  failed: () => Error | null;
  /** Whether no more pieces will come. */
  closed: () => boolean;
  /** Stores the next piece (after every piece before it). */
  add: (piece: Blob) => Promise<void>;
  /** Hears each piece stored, and the close. Returns a function that stops listening. */
  onChange: (listener: () => void) => () => void;
  /** The pieces from `from` to `to` (inclusive). */
  pieces: (from: number, to: number) => Promise<Blob[]>;
  /** Every stored piece, as one file. */
  file: () => Promise<File>;
  upload: () => RecordingUpload | null;
  setUpload: (upload: RecordingUpload) => Promise<void>;
  keptWith: () => unknown;
  setKeptWith: (keptWith: unknown) => Promise<void>;
  seconds: () => number;
  setSeconds: (seconds: number) => void;
  /** No more pieces will come; resolves once every piece and the journal are written. */
  close: () => Promise<void>;
  /** Deletes the device copy (kept elsewhere, or thrown away). */
  forget: () => Promise<void>;
  /** This tab lets go of the recording without finishing it (its screen closed): the device copy stays and is offered
   *  again by `unfinishedRecordings` at once. */
  release: () => Promise<void>;
};

type Opening = {
  id: string; name: string; mediaType: string; startedAt: Date; account?: string | null; keptWith?: unknown;
  stored?: number; storedBytes?: number; seconds?: number; upload?: RecordingUpload | null; closed?: boolean;
};

let heldTab: string | null = null;
/** This tab's name, made on first use: a Worker refuses randomness while its modules load. */
const thisTab = () => (heldTab ??= `tab:${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`);

/** Holds a recording on this device: a new one as it starts, or one found again after a reload. */
export function keepOnDevice(opening: Opening, store: DeviceStore = browserDeviceStore, now: () => number = Date.now): DeviceRecording {
  let stored = opening.stored ?? 0;
  let storedBytes = opening.storedBytes ?? 0;
  let handed = stored;
  let failure: Error | null = null;
  let closed = opening.closed ?? false;
  let upload: RecordingUpload | null = opening.upload ?? null;
  let keptWith = opening.keptWith ?? null;
  let seconds = opening.seconds ?? 0;
  let revision = 0;
  let forgotten = false;
  let held = true;
  let writing: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();
  const tell = () => { for (const listener of listeners) listener(); };

  const journal = (count = stored): CaptureJournal => {
    revision += 1;
    const sequences = Array.from({ length: count }, (_, index) => index);
    return {
      recording_id: opening.id, recorded_file_id: opening.name, recorded_at: opening.startedAt.toISOString(),
      phase: closed ? 'stopping' : 'recording', capture_kind: opening.mediaType.split('/')[0] || 'audio', media_type: opening.mediaType,
      completion_reason_ref: null, completion_source_ref: null, completion_observed_at: null,
      active_duration_ms: Math.round(seconds * 1000), expected_sequences: sequences, stored_sequences: sequences, failed_sequences: failure ? [stored] : [],
      owner_instance_ref: thisTab(), owner_lease_expires_at: new Date(now() + (held ? LEASE_MS : 0)).toISOString(),
      // Later writes always carry a higher revision, across reloads too (the store keeps only a newer revision).
      journal_revision: now() * 1000 + (revision % 1000), updated_at: new Date(now()).toISOString(),
      ...(upload ? { upload } : {}), kept_with: keptWith, account: opening.account ?? null,
    };
  };
  // Journal writes go one after another, after the piece writes before them, so the journal never counts a piece the
  // device does not hold.
  const save = () => {
    const pending = writing.then(() => (forgotten ? undefined : store.writeJournal(journal())));
    writing = pending.catch(() => undefined);
    return pending;
  };
  const renew = setInterval(() => { void save().catch(() => undefined); }, RENEW_MS);

  const recording: DeviceRecording = {
    id: opening.id, name: opening.name, mediaType: opening.mediaType, startedAt: opening.startedAt,
    stored: () => stored,
    storedBytes: () => storedBytes,
    failed: () => failure,
    closed: () => closed,
    add: piece => {
      const sequence = handed;
      handed += 1;
      writing = writing.then(async () => {
        if (failure || forgotten) return;
        try {
          if (store.writePieceAndJournal) await store.writePieceAndJournal(opening.id, sequence, opening.mediaType, piece, journal(sequence + 1));
          else {
            // Legacy/custom stores without transactions put discovery first. Recovery checks the actual contiguous
            // bytes before using this count, so a failed subsequent piece write never makes a missing piece uploadable.
            await store.writeJournal(journal(sequence + 1));
            await store.writePiece(opening.id, sequence, opening.mediaType, piece);
          }
        }
        catch (error) { failure = error instanceof Error ? error : new Error(String(error)); tell(); return; }
        stored = sequence + 1;
        storedBytes += piece.size;
        tell();
      });
      return writing;
    },
    onChange: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    pieces: (from, to) => store.readPieces(opening.id, from, to, opening.mediaType),
    file: async () => new File(await store.readPieces(opening.id, 0, stored - 1, opening.mediaType), opening.name, { type: opening.mediaType, lastModified: opening.startedAt.getTime() }),
    upload: () => upload,
    setUpload: async next => {
      const previous = upload;
      upload = next;
      try { await save(); } catch (error) { if (upload === next) upload = previous; throw error; }
    },
    keptWith: () => keptWith,
    setKeptWith: next => { keptWith = next; return save(); },
    seconds: () => seconds,
    setSeconds: next => { seconds = next; },
    close: async () => {
      closed = true;
      await save();
      await writing;
      tell();
    },
    forget: async () => {
      clearInterval(renew);
      closed = true;
      await writing;
      await store.forget(opening.id);
      forgotten = true;
      tell();
    },
    release: async () => {
      clearInterval(renew);
      held = false;
      await save();
      await writing;
    },
  };
  void save().catch(() => undefined);
  return recording;
}

/** Recordings of `account` on this device whose tab never finished them (closed or reloaded while recording or
 *  sending), newest first. */
export async function unfinishedRecordings(account: string | null, store: DeviceStore = browserDeviceStore, now: () => number = Date.now): Promise<UnfinishedRecording[]> {
  if (account === null) return [];
  const journals = await store.listJournals();
  const found = journals
    .filter(journal => !['saved', 'cancelled'].includes(journal.phase)
      && (journal.account ?? null) === account
      && captureJournalRecoveryState(journal, null, now()) === 'recover'
      && journal.stored_sequences.length > 0)
    .map(journal => ({
      id: journal.recording_id, name: journal.recorded_file_id, mediaType: journal.media_type,
      startedAt: new Date(journal.recorded_at ?? journal.updated_at), seconds: journal.active_duration_ms / 1000,
      stored: journal.stored_sequences.length, account: journal.account ?? null, keptWith: journal.kept_with ?? null, upload: journal.upload ?? null,
    }))
    .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime());
  // Discovery-first custom stores can name a piece whose byte write failed. Never upload or delete a truncated
  // recording: leave the journal and every byte intact when its advertised sequence is not readable.
  for (const item of found) {
    for (let sequence = 0; sequence < item.stored; sequence++) {
      const pieces = await store.readPieces(item.id, sequence, sequence, item.mediaType);
      if (!(pieces[0] instanceof Blob)) throw new Error('A recording piece could not be read. Its device copy was kept.');
    }
  }
  return found;
}

/** The unfinished recordings of `account` among `journals`: the only ones this page may recover or rewrite. Nothing is
 *  returned with no account signed in, and another account's, or one that names no account, is left as it is. */
export function unfinishedJournalsOf(journals: CaptureJournal[], account: string | null): CaptureJournal[] {
  if (account === null) return [];
  return journals.filter(journal => !['saved', 'cancelled'].includes(journal.phase) && (journal.account ?? null) === account);
}

/** Holds a recording found on this device again, to finish sending it; no more pieces will come to it. */
export const reopenOnDevice = (found: UnfinishedRecording, store: DeviceStore = browserDeviceStore, now: () => number = Date.now) =>
  keepOnDevice({
    id: found.id, name: found.name, mediaType: found.mediaType, startedAt: found.startedAt, account: found.account, keptWith: found.keptWith,
    stored: found.stored, seconds: found.seconds, upload: found.upload, closed: true,
  }, store, now);
