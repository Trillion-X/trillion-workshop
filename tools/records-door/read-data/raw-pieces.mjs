// tools/records-door/read-data/raw-pieces.mjs
//
// Purpose: a file of any size kept as one of the person's files through a run's own door, in raw pieces. The Files session
// tool (tool:your-files) is called as every files right calls it, `tools:run` { tool, call: { name, arguments } } at the
// tools address: write_file_start names the upload and the whole length, each piece goes as the body of one POST whose
// Content-Type is application/octet-stream and whose X-Call header is the base64url of that same tools/call JSON (the engine
// keeps the body and hands it to the session as the piece's `content_file`: the engine's src/mcp/upload.rs, the row's
// session.byte_argument), and write_file_finish closes it under the file's identity. Until Nov 20 2026 a file above 16 MiB
// went over a lease road (/namespace/leases) the engine no longer serves, so no run kept a large file; a 40 KiB base64 piece
// would take about 800,000 calls for a 31 GB recording, a 32 MiB raw piece about 950.
//
// Non-Negotiable Invariants:
//   1. One upload id names the whole upload. A piece that failed in a way that may or may not have taken effect (a lost
//      connection, a busy or throttled door, an unknown outcome) is never guessed at: write_file_start is asked again under
//      the same id, and its next_offset says where to go on. So a retried upload resumes and never writes a piece twice.
//   2. Each piece is read from the source when it is sent and never held beyond it: a file larger than memory is kept.
//   3. A refusal the files tool gives (its code, with outcome not_started) ends the upload with that code; nothing is retried.
//   4. Each start and each piece is sent under a request key of its own (a start asked again must answer where the upload
//      stands now, not the receipt of the first start); only the finish keeps one key, so a finish sent again is one finish.
//   5. The capability is a bearer: it is sent as the Authorization header only, never printed, logged or returned.
//
//   keepInRawPieces(route, name, source, { mediaType, uploadId, pieceBytes }) -> write_file_finish's answer
//     route:  { url, capability, filesTool, toolsAddress?, fetchImpl?, wait? }  (a run's descriptor: url, capability,
//             files_resource, tools_resource)
//     source: { size, readAt(offset, length) }  (whole-file.mjs bufferSource, or the file sender's fileSource)
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Settings of the raw-piece road (large-file.json): piece_bytes, first_wait_ms, most_tries.
export const RAW_PIECES = JSON.parse(readFileSync(fileURLToPath(new URL('./large-file.json', import.meta.url)), 'utf8'));

const PROTOCOL = '2025-06-18';
const WORKSHOP_TOOLS = '@tools';
const MAX_WAIT_MS = 30_000;

export class RawPieceError extends Error {
  constructor(code, message, outcome = 'unknown') {
    super(message);
    this.code = code;
    this.outcome = outcome;
  }
}

// An answer is JSON, or an event stream whose last `data:` line is the JSON answer.
function answerOf(text, contentType) {
  if (!/text\/event-stream/.test(contentType ?? '')) return JSON.parse(text);
  const data = text.split('\n').filter(line => line.startsWith('data:')).at(-1);
  if (!data) throw new Error('empty event stream');
  return JSON.parse(data.slice(5).trim());
}

// One call of the Files tool: JSON when `body` is null, else the body raw with the call in X-Call. Answers the tool's own
// structuredContent; throws RawPieceError, `retry: true` when the outcome is unknown or the door was busy.
async function callFiles(route, name, input, key, body = null) {
  const message = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'do_one_thing_in_my_account',
    arguments: { address: route.toolsAddress ?? WORKSHOP_TOOLS, method: 'tools:run', request_key: key,
      input: { tool: route.filesTool, call: { name, arguments: input } } } } });
  const headers = { authorization: `Bearer ${route.capability}`, accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL };
  if (body === null) headers['content-type'] = 'application/json';
  else {
    headers['content-type'] = 'application/octet-stream';
    headers['x-call'] = Buffer.from(message).toString('base64url');
  }
  const retryable = (code, message) => Object.assign(new RawPieceError(code, message), { retry: true });
  let response;
  try { response = await (route.fetchImpl ?? fetch)(route.url, { method: 'POST', headers, body: body ?? message }); }
  catch { throw retryable('transport_unavailable', 'The door could not be reached.'); }
  if (response.status === 503 || response.status === 429) {
    throw Object.assign(retryable(`http_${response.status}`, `The door answered ${response.status}.`), { retryAfter: response.headers?.get?.('retry-after') });
  }
  if (response.status === 401) throw new RawPieceError('capability_gone', "This run's door has closed.", 'not_started');
  if (response.status === 413) throw new RawPieceError('piece_too_large', 'The door refused a piece as larger than it takes.', 'not_started');
  if (!response.ok) throw new RawPieceError(`http_${response.status}`, `The door answered ${response.status}.`);
  let answer;
  try { answer = answerOf(await response.text(), response.headers.get('content-type')); }
  catch { throw retryable('invalid_answer', 'The door returned an invalid answer.'); }
  const result = answer?.result;
  if (!result || typeof result !== 'object' || answer.error) throw new RawPieceError('rpc_error', 'The door returned an error.');
  if (result.isError) {
    const { code = 'refused', outcome } = result.structuredContent ?? {};
    if (code === 'selected_owner_unavailable' || outcome === 'unknown') throw retryable(code, 'The door was busy or its outcome is unknown.');
    throw new RawPieceError(code, 'The door refused the call.', outcome === 'not_started' ? 'not_started' : 'unknown');
  }
  // The session's answer: { tool, result: { structuredContent, isError } }, or { tool, error } when its process failed.
  const ran = result.structuredContent;
  const reply = ran && typeof ran === 'object' ? ran.result : null;
  if (!reply || typeof reply !== 'object' || Object.hasOwn(ran, 'error')) throw new RawPieceError('rpc_error', 'The files tool returned an error.');
  if (reply.isError) {
    const { code = 'refused', outcome } = reply.structuredContent ?? {};
    if (outcome === 'unknown') throw retryable(code, 'The files tool does not know whether the call took effect.');
    throw new RawPieceError(code, 'The files tool refused the call.', outcome === 'not_started' ? 'not_started' : 'unknown');
  }
  return reply.structuredContent;
}

// The wait before a call is sent again: the door's Retry-After (in seconds) when it gives one, else the backoff; then a
// random half-to-whole of that, so uploads from several runs do not return together.
function waitBefore(error, attempt) {
  const hinted = Number(error.retryAfter) * 1000;
  const base = Number.isFinite(hinted) && hinted > 0 ? hinted : RAW_PIECES.first_wait_ms * 2 ** attempt;
  return Math.min(base, MAX_WAIT_MS) * (0.5 + Math.random() / 2);
}

export async function keepInRawPieces(route, name, source, { mediaType = 'application/octet-stream', uploadId = randomBytes(16).toString('hex'), pieceBytes = RAW_PIECES.piece_bytes, bytesPerSecond = RAW_PIECES.most_bytes_per_second ?? 0 } = {}) {
  if (typeof route?.url !== 'string' || typeof route.capability !== 'string' || typeof route.filesTool !== 'string' || !route.filesTool) {
    throw new RawPieceError('no_files', 'This run was not handed a files right.', 'not_started');
  }
  const wait = route.wait ?? (ms => new Promise(done => setTimeout(done, ms)));
  const start = () => callFiles(route, 'write_file_start', { upload_id: uploadId, name, byte_length: source.size, media_type: mediaType ?? 'application/octet-stream' }, `${uploadId}:start:${randomUUID()}`);
  // A call that may be sent again is sent again with the same key after a growing wait; past most_tries it fails.
  let tries = 0;
  const again = async error => {
    if (!error?.retry || (tries += 1) >= RAW_PIECES.most_tries) throw error;
    await wait(waitBefore(error, tries - 1));
  };
  let offset;
  for (;;) {
    try {
      const started = await start();
      // The same file kept again under its own id: the upload is already finished, and its start answers the finish.
      if (started?.state === 'finished') return started;
      offset = started?.next_offset ?? 0;
      break;
    } catch (error) { await again(error); }
  }
  // The pace: the bytes this run has sent, at bytesPerSecond, may not take less time than has passed since it began.
  const now = route.now ?? Date.now;
  const began = now();
  let sentHere = 0;
  while (offset < source.size) {
    const due = bytesPerSecond > 0 ? began + (sentHere * 1000) / bytesPerSecond - now() : 0;
    if (due > 0) await wait(due);
    const length = Math.min(pieceBytes, source.size - offset);
    const body = Buffer.from(await source.readAt(offset, length));
    try {
      await callFiles(route, 'write_file_piece', { upload_id: uploadId, name, offset }, `${uploadId}:piece:${offset}:${randomUUID()}`, body);
      offset += body.length;
      sentHere += body.length;
      tries = 0;
    } catch (error) {
      await again(error);
      // Where to go on is the upload's own answer, never a guess about the piece that failed.
      for (;;) {
        try { offset = (await start())?.next_offset ?? offset; break; } catch (startError) { await again(startError); }
      }
    }
  }
  for (;;) {
    try { return await callFiles(route, 'write_file_finish', { upload_id: uploadId, name }, `${uploadId}:finish`); }
    catch (error) { await again(error); }
  }
}
