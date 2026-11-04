// tools/record-my-screen/do-work/rebuild-a-recording-from-chunks.mjs
//
// The part of recording the screen that runs without a browser: keeping a recording's chunks while it is made and
// rebuilding the finished file from them, through the folder's own store (recorded-file-store.ts storeRecordingChunk,
// storedRecordedFileRef, readRecordedFileBlob). The browser keeps chunks in IndexedDB; here the same calls run against
// a stand-in IndexedDB held in this run's memory, so each chunk is put under the key the browser would use, the file
// reference a finished recording is published with is built from what was kept, and the recording is read back in
// order and checked against the chunks given.
//
// Inputs: recording_id (screen-record:<words> when given; one is made when left out), media_type ("video/webm" when
// left out), chunks ([{ base64 } or { text }], in the order they were recorded; at most 1000 and 8 MB in all),
// observed_at (ISO time each chunk is stamped with; now when left out).
// Refuses no chunks, a chunk with neither base64 nor text, too many chunks or bytes, and a recording id of another
// shape. Nothing survives the run: it captures no screen, keeps nothing in any browser and publishes nothing.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { readRecordedFileBlob, storeRecordingChunk, storedRecordedFileRef } from './recorded-file-store.ts';

const MAX_CHUNKS = 1000;
const MAX_BYTES = 8 * 1024 * 1024;

// A stand-in for the browser's IndexedDB, only as much as recorded-file-store.ts asks of it, held in this run's memory.
function memoryIndexedDB() {
  const stores = new Map();
  const later = fn => setTimeout(fn, 0);
  const database = {
    objectStoreNames: { contains: name => stores.has(name) },
    createObjectStore(name, { keyPath }) { stores.set(name, { keyPath, rows: new Map() }); },
    transaction(name) {
      const store = stores.get(name);
      const transaction = { error: null, onerror: null, oncomplete: null };
      transaction.objectStore = () => ({
        put(record) { store.rows.set(record[store.keyPath], structuredClone(record)); },
        get(key) {
          const request = { result: undefined, error: null, onsuccess: null, onerror: null };
          later(() => { request.result = store.rows.get(key); request.onsuccess?.(); });
          return request;
        },
      });
      later(() => transaction.oncomplete?.());
      return transaction;
    },
    close() {},
  };
  return {
    open() {
      const request = { result: database, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      later(() => { request.onupgradeneeded?.(); request.onsuccess?.(); });
      return request;
    },
    keys: name => [...(stores.get(name)?.rows.keys() ?? [])],
  };
}

const identity = bytes => `1f:${bytesToHex(blake3(bytes))}`;

export async function rebuildARecordingFromChunks({ recording_id, media_type = 'video/webm', chunks, observed_at } = {}) {
  if (recording_id !== undefined && (typeof recording_id !== 'string' || !/^screen-record:[A-Za-z0-9._-]{1,128}$/.test(recording_id))) {
    throw new Error('Give recording_id as screen-record:<letters, digits, . _ or ->, or leave it out to have one made.');
  }
  if (typeof media_type !== 'string' || !/^[a-z]+\/[A-Za-z0-9.+-]+(;.*)?$/.test(media_type)) throw new Error('Give media_type as a media type, for example video/webm.');
  if (!Array.isArray(chunks) || chunks.length === 0) throw new Error('Give chunks: [{ base64 } or { text }], in the order they were recorded.');
  if (chunks.length > MAX_CHUNKS) throw new Error(`Give at most ${MAX_CHUNKS} chunks.`);
  const at = observed_at === undefined ? new Date().toISOString() : (Number.isFinite(Date.parse(observed_at)) ? new Date(observed_at).toISOString() : null);
  if (!at) throw new Error('Give observed_at as an ISO time, or leave it out.');
  const parts = chunks.map((chunk, index) => {
    if (typeof chunk?.base64 === 'string') return new Uint8Array(Buffer.from(chunk.base64, 'base64'));
    if (typeof chunk?.text === 'string') return new TextEncoder().encode(chunk.text);
    throw new Error(`Chunk ${index} needs base64 (its bytes) or text.`);
  });
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  if (total > MAX_BYTES) throw new Error(`The chunks hold ${total} bytes; give at most ${MAX_BYTES}.`);

  const id = recording_id ?? `screen-record:${crypto.randomUUID()}`;
  const stand_in = memoryIndexedDB();
  const browserStore = globalThis.indexedDB;
  globalThis.indexedDB = stand_in;
  try {
    const chunkRefs = [];
    for (const [sequence, part] of parts.entries()) {
      chunkRefs.push(await storeRecordingChunk({ recordingId: id, sequence, mediaType: media_type, chunk: new Blob([part], { type: media_type }), observedAt: at }));
    }
    const file = storedRecordedFileRef({ recordingId: id, mediaType: media_type, chunkRefs });
    const rebuilt = new Uint8Array(await (await readRecordedFileBlob(file)).arrayBuffer());
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { joined.set(part, offset); offset += part.length; }
    return {
      file,
      kept_keys: stand_in.keys(file.store),
      rebuilt: { byte_length: rebuilt.length, media_type: file.media_type, identity: identity(rebuilt), matches_chunks: identity(rebuilt) === identity(joined) },
    };
  } finally {
    if (browserStore === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = browserStore;
  }
}
