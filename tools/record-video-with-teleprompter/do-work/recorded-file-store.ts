export type LocalPlaybackChunkRef = {
  key: string;
  byte_length: number;
};

export type LocalPlaybackFileRef = {
  kind: 'local-playback.indexeddb-chunks';
  database: 'record-video';
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

const DATABASE_NAME = 'record-video';
const DATABASE_VERSION = 2;
const CHUNK_STORE = 'recorded-chunks';
const JOURNAL_STORE = 'capture-journals';

export type CaptureJournal = {
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
};

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
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open recording storage.'));
    request.onsuccess = () => resolve(request.result);
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
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not save capture recovery journal.'));
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
