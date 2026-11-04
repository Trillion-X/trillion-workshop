// Purpose: send one file on this computer into a hosted namespace as content-defined chunks, so it can be opened,
// played and shared the moment its upload starts, and so no chunk the namespace already holds is ever sent again.
// Every uploader (a folder a customer points at, a drive's table of recordings) sends its files through this one
// function, so they share one set of retry, priority and refusal rules.
//
// What it does for one file:
//   1. start a growing file, named at once; if the caller knows the file's identity and the namespace already holds
//      it, the file is only named and nothing is sent (a duplicate finishes in one request)
//   2. describe the whole file as chunks (boundaries and BLAKE3 identities from crates/content-chunks, ~600 MB/s),
//      sending the description in batches; the namespace answers which chunks it does not hold yet
//   3. send those chunks, `parallel` at a time, each checked against its identity on arrival; chunks a reader is
//      waiting for (the namespace's demands, read every couple of seconds) jump the queue
//   4. finish under the file's whole BLAKE3 identity, computed during step 2
//
// Invariants:
// - The file is read in place through `source.readAt`, so the same sender runs in Node (fileSource below) and in a
//   browser (a File's slices); at most `parallel` chunks are in memory at once and nothing is staged anywhere.
// - A dropped connection, a 5xx, or a reply that is not JSON is sent again a few times. A refusal (`refused: true`:
//   the storage will not keep the file) is thrown as NamespaceRefused at once and is never retried.
// - The chunker is handed in (`chunking`: the content-chunks bindings), so this file runs anywhere the wasm loads.
import sendSettings from '../send-settings.json' with { type: 'json' };
import { outcomeOf, windowOf } from './send-window.mjs';
import { canRetrySendFailure, canRetrySendResponse } from './send-retry.mjs';

/** The service's storage refused the file; sending it again cannot help until the store is fixed. */
export class NamespaceRefused extends Error {
  constructor(message, passedOver = [], status = null) { super(message); this.name = 'NamespaceRefused'; this.passedOver = passedOver; if (typeof status === 'number') this.status = status; }
}

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const httpError = (status, message) => Object.assign(new Error(message), { status });
// A request that fails in passing (a dropped connection, a 5xx while the service restarts) is sent again after each
// wait: 1, 2, 4, 8, 16, 30, 30 seconds, about a minute and a half in all.
const ATTEMPTS = 8;
const retryWait = attempt => Math.min(1000 * 2 ** (attempt - 1), 30 * 1000);

/**
 * A budget of bytes in flight shared by every file one process sends: a chunk takes its size before it is read and
 * gives it back when the service has answered. Memory then stays near `limit` however many files go at once. A chunk
 * larger than the whole budget goes alone.
 */
export function byteBudget(limit) {
  let free = limit;
  const queue = [];
  const wake = () => {
    while (queue.length && (queue[0].bytes <= free || free === limit)) { const waiter = queue.shift(); free -= waiter.bytes; waiter.resolve(); }
  };
  return {
    take: bytes => new Promise(resolve => { queue.push({ bytes, resolve }); wake(); }),
    give: bytes => { free += bytes; wake(); },
  };
}
const READ_BYTES = 8 * 1024 * 1024;
const SPANS_PER_REQUEST = 256;
// The description is sent at least this often, so a reader can open any part the uploader has read within a second.
const SPANS_EVERY_MS = 1000;
const DEMAND_POLL_MS = 2000;
export const CHUNK_SIZES = { min: 2 * 1024 * 1024, average: 8 * 1024 * 1024, max: 16 * 1024 * 1024 };

// One request whose answer is JSON: sent again on a network failure, a 5xx that is not a refusal, or a non-JSON reply.
async function askJson(client, pathPart, init, attempts = ATTEMPTS) {
  for (let attempt = 1; ; attempt += 1) {
    let response, text;
    try {
      response = await client.grow(pathPart, init);
      text = await response.text();
    } catch (error) {
      if (attempt >= attempts || !canRetrySendFailure(error)) throw error;
      await pause(retryWait(attempt));
      continue;
    }
    let body = null;
    try { body = JSON.parse(text); } catch {}
    if (body?.refused) throw new NamespaceRefused(body.error ?? `The service refused this file (${response.status}).`, body.passed_over ?? [], response.status);
    if (canRetrySendResponse(response, body === null) && attempt < attempts) { await pause(retryWait(attempt)); continue; }
    if (body === null) throw httpError(response.status, `The service answered without a readable reply: ${text.slice(0, 200)}`);
    return { ok: response.ok, status: response.status, body };
  }
}
const json = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// Buffers a chunk is read into for sending, kept for the next chunk once the service has answered, so a long upload
// reuses a few buffers instead of leaving one behind per chunk (freed memory the allocator keeps grows the process).
const spareChunkBuffers = [];
const chunkBuffer = () => spareChunkBuffers.pop() ?? new Uint8Array(CHUNK_SIZES.max);
const giveBackChunkBuffer = buffer => { if (spareChunkBuffers.length < 32) spareChunkBuffers.push(buffer); };


// Files at or under this size go many to a request (sendWholeFiles); larger ones grow chunk by chunk (sendFile).
export const WHOLE_FILE_BYTES = CHUNK_SIZES.max;
const WHOLE_FILES_PER_REQUEST = 256;
const WHOLE_FILES_BYTES_PER_REQUEST = 32 * 1024 * 1024;
// A whole-files request that has not answered by then is given up and sent again.
const WHOLE_FILES_ANSWER_MS = 120 * 1000;

// One whole-files request: a 4-byte manifest length, the manifest, then the bytes of the files that carry them.
async function keepWholeFilesRequest(client, entries, contents) {
  const manifest = new TextEncoder().encode(JSON.stringify({ files: entries }));
  const body = new Uint8Array(4 + manifest.length + contents.reduce((sum, piece) => sum + piece.length, 0));
  new DataView(body.buffer).setUint32(0, manifest.length);
  body.set(manifest, 4);
  let at = 4 + manifest.length;
  for (const piece of contents) { body.set(piece, at); at += piece.length; }
  for (let attempt = 1; ; attempt += 1) {
    let response, text;
    try { response = await client.keepWholeFiles(body, { signal: AbortSignal.timeout(WHOLE_FILES_ANSWER_MS) }); text = await response.text(); }
    catch (error) { if (attempt >= ATTEMPTS || !canRetrySendFailure(error)) throw error; await pause(retryWait(attempt)); continue; }
    let reply = null;
    try { reply = JSON.parse(text); } catch {}
    if (reply?.refused) return { ...reply, status: response.status };
    if (canRetrySendResponse(response, reply === null) && attempt < ATTEMPTS) { await pause(retryWait(attempt)); continue; }
    if (!response.ok) throw httpError(response.status, `The service did not keep these files: ${reply?.error ?? text.slice(0, 200)}`);
    return reply;
  }
}

/**
 * Send small files many to a request. files: [{ source, name?, modifiedAtMs?, mediaType?, aliases?, identity? }], each
 * source at most WHOLE_FILE_BYTES. A file whose identity is known (given, or measured here when `chunking` is passed)
 * is first only named: the service names every one it already holds, and only the bytes of the rest are sent, so a
 * duplicate is never sent again and a file given with its identity is not read unless the service lacks it. Answers,
 * in the same order, [{ state: 'uploaded' | 'already-there', identity }]. `onFiles(n, bytes)` hears each batch kept
 * with the bytes actually sent. A refusal is thrown as NamespaceRefused; a dropped connection or a 5xx is sent again.
 */
export async function sendWholeFiles({ client, files, chunking = null, beforeSend = async () => {}, onFiles = () => {} }) {
  const answers = [];
  const entry = (file, identity) => ({ byte_length: file.source.size, ...(identity ? { identity } : {}), ...(file.name ? { name: file.name } : {}), ...(file.mediaType ? { media_type: file.mediaType } : {}), ...(file.modifiedAtMs ? { modified_at_ms: Math.round(file.modifiedAtMs) } : {}), ...(file.aliases?.length ? { aliases: file.aliases } : {}) });
  for (let start = 0; start < files.length;) {
    let end = start, size = 0;
    while (end < files.length && end - start < WHOLE_FILES_PER_REQUEST && (end === start || size + files[end].source.size <= WHOLE_FILES_BYTES_PER_REQUEST)) size += files[end++].source.size;
    const batch = files.slice(start, end);
    const contents = new Array(batch.length).fill(null);
    const identities = batch.map(file => file.identity ?? null);
    if (chunking) {
      await Promise.all(batch.map(async (file, index) => {
        if (identities[index]) return;
        contents[index] = await file.source.readAt(0, file.source.size);
        identities[index] = `1f:${chunking.digest_hex(contents[index])}`;
      }));
    }
    const settled = new Array(batch.length).fill(null);
    const named = batch.map((_, index) => index).filter(index => identities[index]);
    if (named.length) {
      const reply = await keepWholeFilesRequest(client, named.map(index => entry(batch[index], identities[index])), []);
      if (reply.refused) {
        const refusal = new NamespaceRefused(reply.error, reply.passed_over ?? [], reply.status);
        refusal.answers = [...answers];
        throw refusal;
      }
      reply.files.forEach((file, position) => { if (file.state !== 'needed') settled[named[position]] = { state: 'already-there', identity: file.identity }; });
    }
    const sending = batch.map((_, index) => index).filter(index => !settled[index]);
    let bytes = 0;
    if (sending.length) {
      await Promise.all(sending.map(async index => { contents[index] ??= await batch[index].source.readAt(0, batch[index].source.size); }));
      bytes = sending.reduce((sum, index) => sum + contents[index].length, 0);
      await beforeSend(bytes);
      const reply = await keepWholeFilesRequest(client, sending.map(index => entry(batch[index], null)), sending.map(index => contents[index]));
      if (reply.refused) {
        // The files before the refused one were kept; they are answered with the refusal so nothing kept goes uncounted.
        const kept = reply.kept ?? [];
        const answered = [];
        for (let index = 0; index < batch.length; index += 1) {
          const position = sending.indexOf(index);
          if (settled[index]) answered.push(settled[index]);
          else if (position < kept.length) answered.push({ state: 'uploaded', identity: kept[position] });
          else break;
        }
        const refusal = new NamespaceRefused(reply.error, reply.passed_over ?? [], reply.status);
        refusal.answers = [...answers, ...answered];
        throw refusal;
      }
      reply.files.forEach((file, position) => { settled[sending[position]] = { state: file.state === 'stored' ? 'uploaded' : 'already-there', identity: file.identity }; });
    }
    answers.push(...settled);
    onFiles(batch.length, bytes);
    start = end;
  }
  return answers;
}

export async function sendFile({ client, source, identity = null, aliases = [], name = null, modifiedAtMs = null, mediaType = null, chunking, parallel = 16, budget = null, beforeSend = async () => {}, onChunk = () => {}, onGrowing = () => {} }) {
  const size = source.size;
  const started = await askJson(client, '', json({ byte_length: size, media_type: mediaType, ...(identity ? { identity } : {}), ...(aliases.length ? { aliases } : {}), ...(name ? { name } : {}), ...(modifiedAtMs ? { modified_at_ms: Math.round(modifiedAtMs) } : {}) }));
  if (!started.ok) throw httpError(started.status, `The service would not start this file: ${started.body.error ?? JSON.stringify(started.body)}`);
  if (started.body.state === 'present') return { state: 'already-there', identity: started.body.file.identity, growing: null, chunks: null, chunks_already_held: null, passed_over: [] };
  const growing = started.body.growing;
  onGrowing({ growing });
  const spans = [];          // every chunk of the file, in order: { ordinal, offset, length, chunk }
  const waiting = [];        // ordinals the namespace does not hold, in file order
  const urgent = [];         // ordinals a reader is waiting for
  const sent = new Set();    // ordinals stored, or in flight
  let described = false, refusal = null, failure = null, chunksHeld = 0;
  const requireSending = () => { if (refusal || failure) throw refusal ?? failure; };
  // Describe the file (fast, disk speed) while chunks go up (link speed); the two run side by side.
  const describing = (async () => {
    const chunker = new chunking.Chunker(CHUNK_SIZES.min, CHUNK_SIZES.average, CHUNK_SIZES.max);
    const whole = new chunking.Identity();
    let pending = [], offset = 0, chunkStart = 0, recordedAt = 0, carried = 0;
    // One buffer for the whole pass: each read is hashed and cut before the next overwrites it. A chunk's identity is
    // hashed as its bytes go by (`piece`), so a chunk running across reads is never copied.
    const reading = new Uint8Array(READ_BYTES);
    let piece = new chunking.Identity();
    const record = async (final = false) => {
      requireSending();
      if (!pending.length || (!final && pending.length < SPANS_PER_REQUEST && Date.now() - recordedAt < SPANS_EVERY_MS)) return;
      recordedAt = Date.now();
      const batch = pending.splice(0);
      const answer = await askJson(client, `${growing}/spans`, json({ spans: batch }));
      requireSending();
      if (!answer.ok) throw httpError(answer.status, `The service did not take this file's chunks: ${answer.body.error}`);
      const needed = new Set(answer.body.needed);
      for (const span of batch) { if (needed.has(span.ordinal)) waiting.push(span.ordinal); else { sent.add(span.ordinal); chunksHeld += 1; } }
    };
    const close = length => {
      const span = { ordinal: spans.length, offset: chunkStart, length, chunk: `1f:${piece.hex()}` };
      piece.free();
      piece = new chunking.Identity();
      spans.push(span); pending.push(span);
      chunkStart += length;
    };
    while (offset < size) {
      requireSending();
      const bytes = await source.readAt(offset, Math.min(READ_BYTES, size - offset), reading);
      requireSending();
      whole.update(bytes);
      let at = 0;
      for (const length of chunker.push(bytes)) {
        const end = at + length - carried;
        piece.update(bytes.subarray(at, end));
        close(length);
        at = end; carried = 0;
      }
      if (at < bytes.length) { piece.update(bytes.subarray(at)); carried += bytes.length - at; }
      offset += bytes.length;
      await record();
    }
    const last = chunker.finish();
    if (last) close(last);
    piece.free();
    await record(true);
    requireSending();
    described = true;
    return `1f:${whole.hex()}`;
  })();
  describing.catch(error => { failure ??= error; });

  // Chunks a reader asked for go first. The wait between reads ends as soon as every chunk is sent, so a small file
  // finishes in the time its bytes take, not the time of one more demand read.
  let allSent;
  const sendingEnded = new Promise(resolve => { allSent = resolve; });
  const watching = (async () => {
    while (!refusal && !failure && !(described && sent.size === spans.length)) {
      await Promise.race([pause(DEMAND_POLL_MS), sendingEnded]);
      if (refusal || failure || (described && sent.size === spans.length)) break;
      const asked = await askJson(client, `${growing}/demands`, { method: 'GET' }).catch(() => null);
      for (const ordinal of asked?.body?.ordinals ?? []) if (!sent.has(ordinal) && !urgent.includes(ordinal)) urgent.push(ordinal);
    }
  })();

  const gate = windowOf(client, sendSettings.in_flight_per_person);
  const sendOne = async ordinal => {
    const span = spans[ordinal];
    // A send holds one whole chunk buffer, so the budget counts buffers: memory is the budget, reused, not re-allocated.
    await budget?.take(CHUNK_SIZES.max);
    const into = chunkBuffer();
    try {
      for (let attempt = 1; ; attempt += 1) {
        const bytes = await source.readAt(span.offset, span.length, into);
        await beforeSend(bytes.length);
        let response, text;
        // Each try holds a place in the person's window (send-window.mjs) and gives it back with the service's answer.
        await gate.take();
        try {
          response = await client.grow(`${growing}/chunks/${span.chunk}`, { method: 'PUT', body: bytes });
          text = await response.text();
          gate.give(outcomeOf(response.status, gate.rules));
        } catch (error) {
          gate.give(outcomeOf(error?.status, gate.rules));
          if (attempt >= ATTEMPTS || !canRetrySendFailure(error)) throw error;
          await pause(retryWait(attempt));
          continue;
        }
        if (response.ok) { onChunk({ bytes: bytes.length }); return; }
        let body = null;
        try { body = JSON.parse(text); } catch {}
        if (body?.refused) throw new NamespaceRefused(body.error, [], response.status);
        if ((response.status >= 500 || response.status === 422) && attempt < ATTEMPTS) { await pause(retryWait(attempt)); continue; }
        throw httpError(response.status, `The service could not take a file chunk: ${body?.error ?? text.slice(0, 200)}`);
      }
    } finally { giveBackChunkBuffer(into); budget?.give(CHUNK_SIZES.max); }
  };
  const next = () => { for (const list of [urgent, waiting]) while (list.length) { const ordinal = list.shift(); if (!sent.has(ordinal)) return ordinal; } return null; };
  await Promise.all(Array.from({ length: parallel }, async () => {
    while (!refusal && !failure) {
      const ordinal = next();
      if (ordinal === null) { if (described) return; await pause(20); continue; }
      sent.add(ordinal);
      try { await sendOne(ordinal); }
      catch (error) { if (error instanceof NamespaceRefused) refusal ??= error; else failure ??= error; }
    }
  }));
  allSent();
  // A stopped upload is cancelled so it holds no room; chunks already sent stay and are skipped next time.
  if (refusal || failure) {
    await client.grow(growing, { method: 'DELETE' }).catch(() => {});
    throw refusal ?? failure;
  }
  const whole = await describing;
  await watching;
  const done = await askJson(client, `${growing}/finish`, json({ identity: whole }));
  if (!done.ok || done.body.state !== 'present') throw httpError(done.status, `The service did not finish this file: ${done.body.error ?? 'Try again.'}`);
  return { state: 'uploaded', identity: whole, growing, chunks: spans.length, chunks_already_held: chunksHeld, passed_over: [] };
}

/**
 * Send many files together, as fast as the person's service keeps up. Files at or under WHOLE_FILE_BYTES go many to a
 * request (sendWholeFiles) when the client can send whole files; larger ones grow chunk by chunk (sendFile), each
 * asking for `chunks_per_file` chunks at once. `files_at_once` of these run at the same time, every chunk in flight
 * across all of them takes from one budget of `bytes_in_flight`, and all of them share the client's window, so no
 * file waits for another to finish and none is sent faster than the service takes it.
 * files: [{ source, name?, modifiedAtMs?, mediaType? }]. onBytes(index, bytes) hears bytes kept for a file and
 * onDone(index, answer) each file kept. Answers [{ state, identity }] in the files' order. The first failure stops
 * the files not started yet and is thrown once the ones running have finished.
 */
export async function sendFiles({ client, files, chunking, settings = sendSettings.send_files, onBytes = () => {}, onDone = () => {} }) {
  const budget = byteBudget(settings.bytes_in_flight);
  // The ordered answer is required by callers. Pending work is produced only as a worker asks for it.
  const answers = new Array(files.length);
  const whole = typeof client.keepWholeFiles === 'function';
  const isSmall = index => whole && files[index].source.size <= WHOLE_FILE_BYTES;
  let smallCursor = 0;
  let largeCursor = 0;
  // Small files in groups of one request's worth, each group holding its bytes in the budget while it is sent.
  const nextSmallGroup = () => {
    if (smallCursor === files.length) return null;
    const group = [];
    let size = 0;
    while (smallCursor < files.length && group.length < WHOLE_FILES_PER_REQUEST) {
      const index = smallCursor++;
      if (!isSmall(index)) continue;
      const bytes = files[index].source.size;
      if (group.length && size + bytes > WHOLE_FILES_BYTES_PER_REQUEST) {
        smallCursor = index;
        break;
      }
      group.push(index);
      size += bytes;
    }
    if (!group.length) return null;
    return async () => {
      await budget.take(size);
      try {
        const kept = await sendWholeFiles({ client, files: group.map(index => files[index]), chunking });
        group.forEach((index, position) => { answers[index] = kept[position]; onBytes(index, files[index].source.size); onDone(index, kept[position]); });
      } finally { budget.give(size); }
    };
  };
  const nextJob = () => {
    const smallGroup = nextSmallGroup();
    if (smallGroup) return smallGroup;
    while (largeCursor < files.length && isSmall(largeCursor)) largeCursor += 1;
    if (largeCursor === files.length) return null;
    const index = largeCursor++;
    return async () => {
      answers[index] = await sendFile({ client, ...files[index], chunking, parallel: settings.chunks_per_file, budget, onChunk: ({ bytes }) => onBytes(index, bytes) });
      onDone(index, answers[index]);
    };
  };
  let failure = null;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, settings.files_at_once), files.length) }, async () => {
    while (!failure) {
      const job = nextJob();
      if (!job) return;
      try { await job(); } catch (error) { failure ??= error; }
    }
  }));
  if (failure) throw failure;
  return answers;
}
