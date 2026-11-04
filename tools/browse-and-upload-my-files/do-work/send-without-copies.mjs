// parts/live-namespace/do-work/send-without-copies.mjs
//
// Purpose: a fetch for senders running in Node (a computer's uploader) that writes a request's bytes to the socket as
// they are. Node's built-in fetch copies every Uint8Array body before sending it, so an uploader holding a few 16 MiB
// chunks in flight held several times that, and the freed copies stayed with the process: three files at once through
// fetch peaked near 1 GB against a service that answered at once. This one answers with a standard Response, so a
// caller cannot tell it from fetch.
//
// Non-Negotiable Invariants:
//   1. Same shape as fetch(url, { method, headers, body, signal }) → Response; a body is a Uint8Array, a string or absent.
//   2. Connections are kept open and reused (one agent per protocol), as fetch does.
//   3. Nothing is buffered here: the request body is handed to the socket, the answer is streamed back.
//   4. A connection silent for IDLE_MS fails the request, so the caller's retry runs.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

// Node's fetch gives up on a silent connection after 300 s; an upload retries sooner.
const IDLE_MS = 120 * 1000;
const agents = { 'http:': new http.Agent({ keepAlive: true, maxSockets: 64 }), 'https:': new https.Agent({ keepAlive: true, maxSockets: 64 }) };

export function fetchWithoutCopies(address, { method = 'GET', headers = {}, body = null, signal = null } = {}) {
  const url = new URL(address);
  const transport = url.protocol === 'https:' ? https : http;
  const bytes = typeof body === 'string' ? Buffer.from(body) : body instanceof Uint8Array ? Buffer.from(body.buffer, body.byteOffset, body.byteLength) : null;
  if (body !== null && bytes === null) return Promise.reject(new TypeError('This fetch sends a Uint8Array or a string body.'));
  return new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method, agent: agents[url.protocol], signal: signal ?? undefined,
      headers: { ...Object.fromEntries(headers instanceof Headers ? headers.entries() : Object.entries(headers)), ...(bytes ? { 'content-length': String(bytes.byteLength) } : {}) },
    }, answer => {
      const answerHeaders = new Headers();
      for (const [name, value] of Object.entries(answer.headers)) for (const item of [value].flat()) if (item !== undefined) answerHeaders.append(name, String(item));
      const empty = method === 'HEAD' || answer.statusCode === 204 || answer.statusCode === 304;
      if (empty) answer.resume();
      resolve(new Response(empty ? null : Readable.toWeb(answer), { status: answer.statusCode, statusText: answer.statusMessage, headers: answerHeaders }));
    });
    // A connection silent for this long is given up, so a sender's retry takes over instead of waiting forever.
    request.setTimeout(IDLE_MS, () => request.destroy(new Error(`${url.host} sent nothing for ${IDLE_MS / 1000} s.`)));
    request.on('error', reject);
    request.end(bytes ?? undefined);
  });
}
