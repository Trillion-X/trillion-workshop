/**
 * file: packages/ui/show/media-bytes/read-self-describing-chunk-blob.ts
 *
 * PURPOSE: Generic reader for self-describing browser chunk-store refs (L090).
 * A ref names its OWN home — IndexedDB database, object store, ordered chunk
 * keys, and media type — so any surface can resolve playable bytes from a ref
 * without importing the package that produced it.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. Zero producing-package imports — the ref data is the only contract.
 * 2. Zero Society vocabulary — this reader never names what it reads.
 * 3. Read-only: opens databases without upgrade, never writes.
 */

export type SelfDescribingChunkRef = {
  database: string;
  store: string;
  chunk_refs: ReadonlyArray<{ key: string }>;
  media_type?: string;
};

/** True when a value is a self-describing chunk-store ref. */
export function isSelfDescribingChunkRef(value: unknown): value is SelfDescribingChunkRef {
  if (!value || typeof value !== 'object') return false;
  const ref = value as Record<string, unknown>;
  return typeof ref.database === 'string'
    && typeof ref.store === 'string'
    && Array.isArray(ref.chunk_refs)
    && ref.chunk_refs.every((chunk) => !!chunk && typeof (chunk as Record<string, unknown>).key === 'string');
}

/**
 * Resolve a chunk ref to a playable Blob, or null when any chunk is missing
 * (e.g. a different browser profile). Callers decide how to present absence.
 */
export async function readSelfDescribingChunkBlob(ref: SelfDescribingChunkRef): Promise<Blob | null> {
  if (typeof indexedDB === 'undefined') return null;
  const database = await new Promise<IDBDatabase | null>((resolve) => {
    const request = indexedDB.open(ref.database);
    request.onerror = () => resolve(null);
    request.onsuccess = () => resolve(request.result);
  });
  if (!database) return null;
  if (!database.objectStoreNames.contains(ref.store)) {
    database.close();
    return null;
  }
  try {
    const chunks = await Promise.all(ref.chunk_refs.map((chunk) => new Promise<ArrayBuffer | null>((resolve) => {
      const tx = database.transaction(ref.store, 'readonly');
      const request = tx.objectStore(ref.store).get(chunk.key) as IDBRequest<{ bytes?: ArrayBuffer } | undefined>;
      request.onerror = () => resolve(null);
      request.onsuccess = () => resolve(request.result?.bytes ?? null);
    })));
    if (chunks.some((chunk) => !chunk)) return null;
    return new Blob(chunks as ArrayBuffer[], ref.media_type ? { type: ref.media_type } : undefined);
  } finally {
    database.close();
  }
}
