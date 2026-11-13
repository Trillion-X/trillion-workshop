// tools/media-composition/do-work/open-a-clip-link.mjs
//
// PURPOSE
//   Gives a program a clip of the person's Namespace files as an address ffmpeg can open, without copying the clip:
//   `withClipAddress('1f:...', address => ...)` serves the clip on a loopback address (read-data/range-server.mjs)
//   whose bytes come, range by range, from the run's files door (`read_file`, the right the row declares under
//   `invoke.records`), and ends the address when the work is done. Any other address (a web address, a file path)
//   is handed on as it is.
//
//   The address is served from a worker thread because the programs that read it are run to completion by the
//   caller (execFileSync): a server on the caller's own thread could not answer while it waited. The thread opens the
//   door itself, so the caller never holds it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only the bytes a reader asks for are read from the door, one page at a time; the clip is never held whole.
//   2. Every page must be the file named by the identity asked for and start where it was asked to; a page that
//      does not (the file changed) ends the response.
//   3. A run with no right to read files is refused with words before anything is served.
//
//   openClipLink(identity, { descriptor }) -> { url, close() }
//   withClipAddress(video, use, { descriptor }) -> what `use(address)` returns.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
import { CLIP_PATH, rangeServer } from '../read-data/range-server.mjs';

const IDENTITY = /^1f:[0-9a-f]{64}$/;
/** The most bytes asked of the door in one page; the files door answers within one bounded message. */
const PAGE_BYTES = 262144;

const bytesOf = page => Buffer.from(page.content ?? '', page.encoding === 'base64' ? 'base64' : 'utf8');

/** In the worker: open the door, learn the length, serve the ranges, say where. */
async function serve({ identity, descriptor }) {
  const door = openRecordsDoor({ descriptor });
  const first = await door.files('read_file', { name_or_identity: identity, offset: 0, length: 0 });
  if (first.identity !== identity || !Number.isSafeInteger(first.byte_length) || first.byte_length < 1) {
    throw new Error(`The files door did not answer the clip ${identity}.`);
  }
  const server = rangeServer({
    byteLength: first.byte_length,
    read: async (offset, length) => {
      const page = await door.files('read_file', { name_or_identity: identity, offset, length: Math.min(length, PAGE_BYTES) });
      const part = bytesOf(page);
      if (page.identity !== identity || page.offset !== undefined && page.offset !== offset || part.length !== page.bytes_returned) {
        throw new Error(`The clip ${identity} changed or did not answer its bytes from ${offset}.`);
      }
      return part;
    },
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return server.address().port;
}

if (!isMainThread && workerData?.clipLink) {
  try {
    parentPort.postMessage({ port: await serve(workerData.clipLink) });
  } catch (error) {
    parentPort.postMessage({ error: error.message });
  }
}

export async function openClipLink(identity, { descriptor = 3 } = {}) {
  if (!IDENTITY.test(identity)) throw new Error(`${identity} is not a file identity (1f: then 64 hex).`);
  const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { clipLink: { identity, descriptor } } });
  const answer = await new Promise((done, fail) => {
    worker.once('message', done);
    worker.once('error', fail);
    worker.once('exit', code => fail(new Error(`The clip link stopped before it was ready (${code}).`)));
  }).catch(async error => { await worker.terminate(); throw error; });
  if (answer.error) { await worker.terminate(); throw new Error(answer.error); }
  return { url: `http://127.0.0.1:${answer.port}${CLIP_PATH}`, close: async () => { await worker.terminate(); } };
}

export async function withClipAddress(video, use, options) {
  if (!IDENTITY.test(video)) return use(video);
  const link = await openClipLink(video, options);
  try {
    return await use(link.url);
  } finally {
    await link.close();
  }
}
