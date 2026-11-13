// tools/media-composition/read-data/range-server.mjs
//
// PURPOSE
//   The loopback address a clip is read through. ffmpeg and ffprobe open an address and ask for the byte ranges they
//   need (they seek to a file's index, then to the stretch being cut); this answers each range by reading just those
//   bytes from where the file lives, so a one-minute cut of a long recording reads about a minute of it and nothing is
//   copied in first. It knows nothing of where the bytes are: the caller hands in `read(offset, length)`.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A range is answered with exactly the bytes asked for, or the response is ended early so the reader sees a
//      failure; a short body is never passed off as the whole range.
//   2. Nothing is read before a request needs it, and a HEAD request reads nothing.
//   3. Only one address answers (`/source.mp4`), only on the loopback interface by the caller's listen, and only
//      GET and HEAD.
//
//   rangeServer({ byteLength, read }) -> an http.Server the caller listens on.
//   read(offset, length) -> Promise<Buffer>: at least one byte and at most `length`; fewer is asked for again from
//   where it stopped.
import { createServer } from 'node:http';

/** The one address the clip is served at; ffmpeg names no file kind by it, it reads the picture. */
export const CLIP_PATH = '/source.mp4';

/**
 * The bytes a Range header names in a file of `size` bytes: { start, end } (end included), null when no range was
 * asked for, or 'unsatisfiable' for a range that names no byte, more than one range, or a form not understood.
 */
export function parseRange(header, size) {
  if (header === undefined || header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (match[1] === '' && match[2] === '')) return 'unsatisfiable';
  if (match[1] === '') {
    const last = Number(match[2]);
    return last > 0 && size > 0 ? { start: Math.max(0, size - last), end: size - 1 } : 'unsatisfiable';
  }
  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  return start < size && start <= end ? { start, end } : 'unsatisfiable';
}

export function rangeServer({ byteLength, read }) {
  return createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return void response.writeHead(405, { allow: 'GET, HEAD' }).end();
    if (request.url !== CLIP_PATH) return void response.writeHead(404).end();
    const wanted = parseRange(request.headers.range, byteLength);
    if (wanted === 'unsatisfiable') return void response.writeHead(416, { 'content-range': `bytes */${byteLength}` }).end();
    const { start, end } = wanted ?? { start: 0, end: byteLength - 1 };
    response.writeHead(wanted ? 206 : 200, {
      'accept-ranges': 'bytes',
      'content-type': 'video/mp4',
      'content-length': String(end - start + 1),
      ...(wanted ? { 'content-range': `bytes ${start}-${end}/${byteLength}` } : {}),
    });
    if (request.method === 'HEAD') return void response.end();
    let closed = false;
    response.on('close', () => { closed = true; });
    try {
      for (let at = start; at <= end && !closed;) {
        const part = await read(at, end - at + 1);
        if (!part.length) throw new Error(`The bytes from ${at} were not answered.`);
        at += part.length;
        if (!response.write(part)) await new Promise(done => { response.once('drain', done); response.once('close', done); });
      }
      response.end();
    } catch {
      // The head is already sent, so a failure can only end the connection: the reader sees an incomplete response.
      response.destroy();
    }
  });
}
