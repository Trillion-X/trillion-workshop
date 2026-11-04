// packages/screen-recording/do-work/recorded-file-store.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Screen recording chunk storage and file reconstruction using IndexedDB.
// Identical to record-audio/record-video's pattern — this is a shared mechanism.
// Over time, this store logic should be extracted to a leaf module so
// both packages import from the same source (L100, avoid duplication).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Chunks are stored sequentially in IndexedDB with composite keys.
// 2. A recording is reconstructed by reading all chunks in order and
//    creating a Blob with the correct media type.
// 3. Database lifecycle is clean: open, use, close. No lingering handles.
//
// =============================================================================

export type LocalPlaybackChunkRef = {
  key: string;
  byte_length: number;
};

export type LocalPlaybackFileRef = {
  kind: 'local-playback.indexeddb-chunks';
  database: 'screen-recording';
  store: 'recorded-chunks';
  recording_id: string;
  chunk_refs: LocalPlaybackChunkRef[];
  media_type: string;
  byte_length: number;
};

type StoredRecordingChunkRecord = {
  key: string;
  recording_id: string;
  sequence: number;
  media_type: string;
  byte_length: number;
  observed_at: string;
  bytes: ArrayBuffer;
};

const DATABASE_NAME = 'screen-recording';
const DATABASE_VERSION = 1;
const CHUNK_STORE = 'recorded-chunks';

function openRecordingDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This browser cannot save screen recordings.'));
      return;
    }

    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CHUNK_STORE)) {
        database.createObjectStore(CHUNK_STORE, { keyPath: 'key' });
      }
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open screen recording storage.'));
    request.onsuccess = () => resolve(request.result);
  });
}

function putChunk(database: IDBDatabase, record: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(CHUNK_STORE, 'readwrite');
    transaction.objectStore(CHUNK_STORE).put(record);
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not save screen recording chunk.'));
    transaction.oncomplete = () => resolve();
  });
}

function readChunk(database: IDBDatabase, key: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(CHUNK_STORE, 'readonly');
    const request = transaction.objectStore(CHUNK_STORE).get(key) as IDBRequest<StoredRecordingChunkRecord | undefined>;
    request.onerror = () => reject(request.error ?? new Error('Could not read screen recording chunk.'));
    request.onsuccess = () => {
      if (!request.result?.bytes) {
        reject(new Error('Screen recording chunk was not found.'));
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

export function storedRecordedFileRef(input: {
  recordingId: string;
  mediaType: string;
  chunkRefs: LocalPlaybackChunkRef[];
}): LocalPlaybackFileRef {
  return {
    kind: 'local-playback.indexeddb-chunks',
    database: DATABASE_NAME,
    store: CHUNK_STORE,
    recording_id: input.recordingId,
    chunk_refs: input.chunkRefs,
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
