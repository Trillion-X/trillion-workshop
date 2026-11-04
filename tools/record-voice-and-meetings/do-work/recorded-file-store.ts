// parts/record-audio/do-work/recorded-file-store.ts
//
// PURPOSE
//   A recording kept on this device (IndexedDB, database `record-audio`) while it is made: each piece the recorder
//   hands out is stored under a stable key (`<recording>:chunk:<sequence>`), and one journal per recording says what it
//   is, how far it has been stored, who is recording it now (a lease that runs out when the tab goes) and how far it has
//   been sent on (`upload`). A recording whose tab was closed or reloaded is found again from its journal and its pieces
//   (`listCaptureJournals`, `readRecordingChunks`), so nothing recorded is lost to a reload or a dropped connection.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A piece is written under the same key on every attempt, so a retried write never duplicates it.
//   2. A journal only replaces an older revision of itself, and a saved or cancelled one is never brought back.
//   3. Pieces are read back in sequence order; a missing piece is an error, never a gap.
//   4. `forgetRecording` deletes the pieces and the journal together, once the recording is kept elsewhere or thrown
//      away.

export type LocalPlaybackChunkRef = {
  key: string;
  byte_length: number;
};

export type LocalPlaybackFileRef = {
  kind: 'local-playback.indexeddb-chunks';
  database: 'record-audio';
  store: 'recorded-chunks';
  recording_id: string;
  recorded_file_id: string;
  recorded_at: string | null;
  chunk_refs: LocalPlaybackChunkRef[];
  media_type: string;
  byte_length: number;
};

type StoredRecordingChunkRecord = {
  key: string;
  bytes: ArrayBuffer;
};

const DATABASE_NAME = 'record-audio';
const DATABASE_VERSION = 3;
const CHUNK_STORE = 'recorded-chunks';
const JOURNAL_STORE = 'capture-journals';
const MEETING_JOIN_CLAIM_STORE = 'meeting-join-claims';

export type CaptureJournal = {
  surface_completion_target?: import('../../ui/show/placeable-surface-intent/surface-completion-target').PlaceableSurfaceCompletionTarget;
  recording_id: string;
  recorded_file_id: string;
  recorded_at: string | null;
  phase: string;
  capture_kind: string;
  media_type: string;
  completion_reason_ref: string | null;
  completion_source_ref: string | null;
  completion_observed_at: string | null;
  active_duration_ms: number;
  expected_sequences: number[];
  stored_sequences: number[];
  failed_sequences: number[];
  owner_instance_ref: string;
  owner_lease_expires_at: string;
  journal_revision: number;
  updated_at: string;
  /** How far the recording has been sent on while it was made (send-while-recording.ts); absent until it starts. */
  upload?: RecordingUpload;
  /** What the screen that made the recording needs to finish keeping it after a reload (its own words). */
  kept_with?: unknown;
  /** Whose recording this is (an opaque name for the signed-in account), so another account on this device never
   *  finds it. */
  account?: string | null;
  /** The short-lived Join call request this capture consumed, when recording began from Trillion's calendar. */
  meeting_join_invocation_id?: string;
  /** Actual native app-input source evidence; inert through recovery. */
  meeting_application_input_context?: import('./meeting-application-recording').MeetingApplicationInputContext;
  /** The exact calendar event that initiated this capture; metadata never initiates recovery capture. */
  meeting_event_context?: import('./meeting-join-recording').MeetingCalendarContext;
};

type MeetingJoinInvocationClaim = { invocation_id: string; expires_at_ms: number };

/** One request's worth of pieces sent on: pieces `from`..`to` (inclusive), starting at byte `offset`. */
export type SentSpan = { ordinal: number; from: number; to: number; offset: number; length: number; sent: boolean };
/** Where a recording is being sent: the file name, the open upload, the spans sent, and the finished file. */
export type RecordingUpload = { name: string; growing: string | null; spans: SentSpan[]; kept: string | null };

export class RecordingChunkWriteError extends Error {
  constructor(public readonly sequence: number, public readonly attempts: number, cause: unknown) {
    super(`Recording chunk ${sequence} was not saved after ${attempts} attempts: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'RecordingChunkWriteError';
  }
}

function openRecordingDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This browser cannot save recordings in this app.'));
      return;
    }

    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CHUNK_STORE)) {
        database.createObjectStore(CHUNK_STORE, { keyPath: 'key' });
      }
      if (!database.objectStoreNames.contains(JOURNAL_STORE)) {
        database.createObjectStore(JOURNAL_STORE, { keyPath: 'recording_id' });
      }
      if (!database.objectStoreNames.contains(MEETING_JOIN_CLAIM_STORE)) {
        database.createObjectStore(MEETING_JOIN_CLAIM_STORE, { keyPath: 'invocation_id' });
      }
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open recording storage.'));
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

/** Atomically consume one join invocation across mounts, tabs, and cold reloads. */
export async function claimMeetingJoinRecordingInvocation(
  invocationId: string,
  expiresAtMs: number,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!invocationId.trim() || !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return false;
  const checkedAt = performance.now();
  const currentTime = () => nowMs + Math.max(0, performance.now() - checkedAt);
  const database = await openRecordingDatabase();
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const transaction = database.transaction(MEETING_JOIN_CLAIM_STORE, 'readwrite');
      const store = transaction.objectStore(MEETING_JOIN_CLAIM_STORE);
      let claimed = false;
      const existing = store.get(invocationId) as IDBRequest<MeetingJoinInvocationClaim | undefined>;
      existing.onerror = () => reject(existing.error ?? new Error('Could not read the meeting recording request.'));
      existing.onsuccess = () => {
        // Opening storage can wait for an older tab's connection. A request
        // that expired during that wait must never begin capture afterwards.
        if (existing.result || expiresAtMs <= currentTime()) return;
        store.put({ invocation_id: invocationId, expires_at_ms: expiresAtMs } satisfies MeetingJoinInvocationClaim);
        claimed = true;
      };
      const expired = store.openCursor();
      expired.onerror = () => reject(expired.error ?? new Error('Could not clean expired meeting recording requests.'));
      expired.onsuccess = () => {
        const cursor = expired.result;
        if (!cursor) return;
        const row = cursor.value as MeetingJoinInvocationClaim;
        if (row.expires_at_ms <= currentTime()) cursor.delete();
        cursor.continue();
      };
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('Could not consume the meeting recording request.'));
      transaction.oncomplete = () => resolve(claimed);
    });
  } finally {
    database.close();
  }
}

const journalOperations = new Map<string, Promise<void>>();

function enqueueJournalOperation(recordingId: string, operation: () => Promise<void>): Promise<void> {
  const previous = journalOperations.get(recordingId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  journalOperations.set(recordingId, current);
  return current.finally(() => {
    if (journalOperations.get(recordingId) === current) journalOperations.delete(recordingId);
  });
}

export function shouldReplaceCaptureJournal(current: CaptureJournal | undefined, next: CaptureJournal): boolean {
  if (!current) return true;
  if (['saved', 'cancelled'].includes(current.phase)) return false;
  const currentRevision = Number.isSafeInteger(current.journal_revision) ? current.journal_revision : -1;
  return Number.isSafeInteger(next.journal_revision) && next.journal_revision > currentRevision;
}

export function captureJournalRecoveryState(
  journal: CaptureJournal,
  currentRecordingId: string | null,
  nowMs: number,
): 'owned-here' | 'leased-elsewhere' | 'recover' {
  if (currentRecordingId === journal.recording_id) return 'owned-here';
  const leaseExpiresAt = Date.parse(journal.owner_lease_expires_at ?? '');
  return Number.isFinite(leaseExpiresAt) && leaseExpiresAt > nowMs ? 'leased-elsewhere' : 'recover';
}

export async function writeCaptureJournal(journal: CaptureJournal): Promise<void> {
  return enqueueJournalOperation(journal.recording_id, async () => {
    const database = await openRecordingDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(JOURNAL_STORE, 'readwrite');
        const store = transaction.objectStore(JOURNAL_STORE);
        const request = store.get(journal.recording_id) as IDBRequest<CaptureJournal | undefined>;
        request.onerror = () => reject(request.error ?? new Error('Could not read capture recovery journal.'));
        request.onsuccess = () => {
          if (shouldReplaceCaptureJournal(request.result, journal)) store.put(journal);
        };
        transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('Could not save capture recovery journal.'));
        transaction.oncomplete = () => resolve();
      });
    } finally {
      database.close();
    }
  });
}

export async function listCaptureJournals(): Promise<CaptureJournal[]> {
  const database = await openRecordingDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(JOURNAL_STORE, 'readonly');
      const request = transaction.objectStore(JOURNAL_STORE).getAll() as IDBRequest<CaptureJournal[]>;
      request.onerror = () => reject(request.error ?? new Error('Could not read capture recovery journals.'));
      request.onsuccess = () => resolve(request.result ?? []);
    });
  } finally {
    database.close();
  }
}

export async function deleteCaptureJournal(recordingId: string, finalPhase: 'saved' | 'cancelled' = 'saved'): Promise<void> {
  return enqueueJournalOperation(recordingId, async () => {
    const database = await openRecordingDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(JOURNAL_STORE, 'readwrite');
        const store = transaction.objectStore(JOURNAL_STORE);
        const request = store.get(recordingId) as IDBRequest<CaptureJournal | undefined>;
        request.onerror = () => reject(request.error ?? new Error('Could not read capture recovery journal.'));
        request.onsuccess = () => {
          if (!request.result) return;
          store.put({
            ...request.result,
            phase: finalPhase,
            journal_revision: (Number.isSafeInteger(request.result.journal_revision)
              ? request.result.journal_revision
              : 0) + 1,
            updated_at: new Date().toISOString(),
          });
        };
        transaction.onerror = () => reject(transaction.error ?? new Error('Could not clear capture recovery journal.'));
        transaction.oncomplete = () => resolve();
      });
    } finally {
      database.close();
    }
  });
}

function putChunk(database: IDBDatabase, record: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(CHUNK_STORE, 'readwrite');
    transaction.objectStore(CHUNK_STORE).put(record);
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not save recording chunk.'));
    transaction.oncomplete = () => resolve();
  });
}

function readChunk(database: IDBDatabase, key: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(CHUNK_STORE, 'readonly');
    const request = transaction.objectStore(CHUNK_STORE).get(key) as IDBRequest<StoredRecordingChunkRecord | undefined>;
    request.onerror = () => reject(request.error ?? new Error('Could not read recording chunk.'));
    request.onsuccess = () => {
      if (!request.result?.bytes) {
        reject(new Error('Recording chunk was not found.'));
        return;
      }
      resolve(request.result.bytes);
    };
  });
}

export async function storeRecordingChunk(input: {
  recordingId: string;
  sequence: number;
  mediaType: string;
  chunk: Blob;
  observedAt: string;
}): Promise<LocalPlaybackChunkRef> {
  const bytes = await input.chunk.arrayBuffer();
  const key = `${input.recordingId}:chunk:${input.sequence}`;
  const database = await openRecordingDatabase();
  try {
    await putChunk(database, {
      key,
      recording_id: input.recordingId,
      sequence: input.sequence,
      media_type: input.mediaType,
      byte_length: input.chunk.size,
      observed_at: input.observedAt,
      bytes,
    });
  } finally {
    database.close();
  }
  return { key, byte_length: input.chunk.size };
}

/** A successful piece write also makes it discoverable after reload. The bytes and recovery journal commit in
 *  one transaction; neither can survive alone if quota, a journal put or the tab fails during the write. */
export async function storeRecordingPieceAndJournal(recordingId: string, sequence: number, mediaType: string, piece: Blob, journal: CaptureJournal): Promise<void> {
  const bytes = await piece.arrayBuffer();
  return enqueueJournalOperation(recordingId, async () => {
    const database = await openRecordingDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction([CHUNK_STORE, JOURNAL_STORE], 'readwrite');
        const journals = transaction.objectStore(JOURNAL_STORE);
        const request = journals.get(recordingId) as IDBRequest<CaptureJournal | undefined>;
        request.onsuccess = () => {
          if (!shouldReplaceCaptureJournal(request.result, journal)) { transaction.abort(); return; }
          try {
            transaction.objectStore(CHUNK_STORE).put({ key: `${recordingId}:chunk:${sequence}`, recording_id: recordingId, sequence, media_type: mediaType, byte_length: piece.size, observed_at: journal.updated_at, bytes });
            journals.put(journal);
          } catch (error) { transaction.abort(); reject(error); }
        };
        transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('Could not keep the recording and its recovery details together.'));
        transaction.oncomplete = () => resolve();
      });
    } finally { database.close(); }
  });
}

/** Retry only this failed sequence. Its stable key makes every attempt idempotent. */
export async function storeRecordingChunkWithRetry(
  input: Parameters<typeof storeRecordingChunk>[0],
  attempts = 3,
  writer: typeof storeRecordingChunk = storeRecordingChunk,
): Promise<LocalPlaybackChunkRef> {
  let lastError: unknown = new Error('Chunk write did not run.');
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    try {
      return await writer(input);
    } catch (error) {
      lastError = error;
    }
  }
  throw new RecordingChunkWriteError(input.sequence, Math.max(1, attempts), lastError);
}

export function orderedChunkRefs(chunkRefs: LocalPlaybackChunkRef[]): LocalPlaybackChunkRef[] {
  return [...chunkRefs].sort((left, right) => {
    const leftSequence = Number(left.key.slice(left.key.lastIndexOf(':') + 1));
    const rightSequence = Number(right.key.slice(right.key.lastIndexOf(':') + 1));
    return leftSequence - rightSequence;
  });
}

export function storedRecordedFileRef(input: {
  recordingId: string;
  recordedFileId: string;
  recordedAt: string | null;
  mediaType: string;
  chunkRefs: LocalPlaybackChunkRef[];
}): LocalPlaybackFileRef {
  return {
    kind: 'local-playback.indexeddb-chunks',
    database: DATABASE_NAME,
    store: CHUNK_STORE,
    recording_id: input.recordingId,
    recorded_file_id: input.recordedFileId,
    recorded_at: input.recordedAt,
    chunk_refs: orderedChunkRefs(input.chunkRefs),
    media_type: input.mediaType,
    byte_length: input.chunkRefs.reduce((total, chunk) => total + chunk.byte_length, 0),
  };
}

export async function readRecordedFileBlob(storedFileRef: LocalPlaybackFileRef): Promise<Blob> {
  const database = await openRecordingDatabase();
  try {
    const chunks = await Promise.all(
      storedFileRef.chunk_refs.map((chunkRef) => readChunk(database, chunkRef.key)),
    );
    return new Blob(chunks, { type: storedFileRef.media_type });
  } finally {
    database.close();
  }
}

/** The pieces of a recording from sequence `from` to `to` (inclusive), in order. */
export async function readRecordingChunks(recordingId: string, from: number, to: number, mediaType = ''): Promise<Blob[]> {
  if (to < from) return [];
  const database = await openRecordingDatabase();
  try {
    const keys = Array.from({ length: to - from + 1 }, (_, index) => `${recordingId}:chunk:${from + index}`);
    const pieces = await Promise.all(keys.map(key => readChunk(database, key)));
    return pieces.map(bytes => new Blob([bytes], mediaType ? { type: mediaType } : {}));
  } finally {
    database.close();
  }
}

/** Deletes a recording's pieces and its journal from this device. */
export async function forgetRecording(recordingId: string): Promise<void> {
  return enqueueJournalOperation(recordingId, async () => {
    const database = await openRecordingDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction([CHUNK_STORE, JOURNAL_STORE], 'readwrite');
        transaction.objectStore(CHUNK_STORE).delete(IDBKeyRange.bound(`${recordingId}:chunk:`, `${recordingId}:chunk:\uffff`));
        transaction.objectStore(JOURNAL_STORE).delete(recordingId);
        transaction.onerror = () => reject(transaction.error ?? new Error('Could not remove the recording from this device.'));
        transaction.oncomplete = () => resolve();
      });
    } finally {
      database.close();
    }
  });
}
