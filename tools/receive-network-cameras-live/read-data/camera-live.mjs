// src/camera-live.mjs
//
// Purpose: network cameras (a camera body sending RTMPS from a phone hotspot) that Trillion itself receives and keeps,
// replacing the Fly app that ran mediamtx (parts/network-live-camera, removed). Each camera is one Cloudflare Stream
// live input: Stream takes the camera's RTMPS (rtmps://live.cloudflare.com:443/live/) or SRT, plays it back as HLS for
// the Always recording screen, and records every broadcast. When a recording is ready this module copies it, whole,
// into the account's Files at /Recordings/Cameras/{day}/{time} {camera} {id}.mp4, and only after Files acknowledged
// the last byte does it delete Stream's copy, so Stream's storage is a few minutes of footage, not the archive.
//
// Why Stream and not a container: a Trillion container is HTTP-only (src/tools.mjs save_tool: "no network"; Workers
// Containers answer only requests the Worker proxies), so a camera's raw RTMPS on 443 cannot reach one.
//
// What is kept where:
//   KV  camera-input:{live input uid}   { user_id, camera_id, name, rtmps_url, rtmps_key, srt_url, srt_stream_id,
//                                        srt_passphrase, playback_url, created_at }  the owner of that input and its
//                                        ingest key. The key leaves the Worker only through revealCamera, which the
//                                        Always recording screen's own session calls (never an AI tool, never a log).
//   KV  cameras:{user id}               a list of { camera_id, uid }: the account's cameras, in the order added.
//   KV  camera-filing:{video uid}       { state: 'filing' or 'filed', ... }  where a copy into Files has got to.
//   KV  camera-webhook-secret           Stream's signing secret for its one webhook (an account has only one).
//   Files /Camera/live-sources.json     { sources: [{ id, kind: 'hls', label, playback_url, clips_folder, connection,
//                                        ingest_url }] }  what src/workspace/network-live-inputs.tsx draws.
//
// Invariants:
// - The Stream token is the Worker secret CLOUDFLARE_STREAM_TOKEN (src/worker-secrets.json), read only by
//   src/worker-secrets.mjs `secret`. It and every ingest key are absent from every error, log and answer.
// - Only the operator account makes cameras: a recording is stored and delivered on Trillion's Cloudflare bill.
// - A Stream webhook is a wakeup, never evidence (the same rule as src/contract-stripe-webhook.mjs): the video is read
//   again from Stream with the token, and its live input must be one this module made.
// - Stream's copy is deleted only after Files said the last byte is stored. A copy that stops part way resumes from
//   the byte it reached (a ranged read), or starts over when the download cannot be ranged.
import { secret } from '../../start-from-any-landing-page/src/worker-secrets.mjs';
import { readWholeFile, writeWholeFile, PIECE_BYTES } from '../../records-door/read-data/whole-file.mjs';
import { randomUUID } from 'node:crypto';

export const RECORDINGS_FOLDER = '/Recordings/Cameras';
export const SOURCES_FILE = '/Camera/live-sources.json';
export const WEBHOOK_PATH = '/camera/stream-webhook';
const API = 'https://api.cloudflare.com/client/v4';
const PART_BYTES = 8 * 1024 * 1024;
const WEBHOOK_MAX_BYTES = 256 * 1024;
const WEBHOOK_MAX_AGE_SECONDS = 600;
const FILING_BUDGET_MS = 20_000;
const UID = /^[a-f0-9]{32}$/;
const CAMERA_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const inputKey = uid => `camera-input:${uid}`;
export const listKey = userId => `cameras:${userId}`;
export const filingKey = uid => `camera-filing:${uid}`;
export const WEBHOOK_SECRET_KEY = 'camera-webhook-secret';

/** A refusal that has a known cause and a known one-time fix, said without any secret. */
export class CameraWall extends Error {
  constructor(code, message, status = 502) { super(message); this.name = 'CameraWall'; this.code = code; this.status = status; }
}

const slug = name => String(name ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const cleanName = name => String(name ?? '').replace(/[\\/\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
const liveInputOf = video => { const input = video?.liveInput?.uid ?? video?.liveInput; return UID.test(String(input ?? '')) ? input : null; };

/** The Stream API for the Worker's account: api(method, path, body) answers `result` or throws a CameraWall. */
export function streamApi(env, fetchImpl = fetch) {
  const token = secret(env, 'CLOUDFLARE_STREAM_TOKEN');
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) {
    throw new CameraWall('no-stream-token', `This Worker has no ${!token ? 'CLOUDFLARE_STREAM_TOKEN secret' : 'CLOUDFLARE_ACCOUNT_ID setting'}. One time: create a Cloudflare API token with Account > Stream > Edit for this account and set it as the Worker secret CLOUDFLARE_STREAM_TOKEN.`, 503);
  }
  return async function api(method, path, body) {
    let response;
    try {
      response = await fetchImpl(`${API}/accounts/${account}/stream${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new CameraWall('stream-unreachable', 'Cloudflare Stream did not answer. Try again.', 503); }
    const text = await response.text();
    let answer = null;
    try { answer = text ? JSON.parse(text) : null; } catch { /* a reply that is not JSON is reported by its status */ }
    if (response.ok && (answer === null || answer.success !== false)) return answer?.result ?? null;
    const first = answer?.errors?.[0];
    const said = first ? `code ${first.code}: ${String(first.message ?? '').slice(0, 200)}` : `status ${response.status}`;
    if (response.status === 401 || response.status === 403 || first?.code === 10000) {
      throw new CameraWall('stream-permission', `Cloudflare refused the Stream token (${said}). The token needs Account > Stream > Edit on this account, and Stream must be on for it (dash.cloudflare.com > Stream).`, 403);
    }
    throw new CameraWall('stream-refused', `Cloudflare Stream refused the request (${said}).`, response.status === 404 ? 404 : 502);
  };
}

const hostOf = address => { try { const url = new URL(address); return /^customer-[a-z0-9]+\.cloudflarestream\.com$/.test(url.hostname) ? url.hostname : null; } catch { return null; } };
const playbackFor = (host, uid) => (host ? `https://${host}/${uid}/manifest/video.m3u8` : null);

/** Keeps and reads the account's Files through the same owners the phone share uses (loaded when first needed). */
export function accountFiles({ door }) {
  if (!door?.files) throw new CameraWall('no-files-door', 'This camera run has no admitted Files door.', 503);
  return {
    async readText(name) {
      try {
        const file = await readWholeFile(door, name);
        if (!file.bytes) throw new CameraWall('sources-too-large', 'The camera source list is too large.', 413);
        return new TextDecoder().decode(file.bytes);
      } catch (error) { if (error?.code === 'namespace_not_found') return null; throw error; }
    },
    async writeText(name, text) { return writeWholeFile(door, name, new TextEncoder().encode(text), { mediaType: 'application/json' }); },
    async startUpload(input) {
      const upload_id = randomUUID();
      const started = await door.files('write_file_start', { ...input, upload_id });
      return { upload_id, name: input.name, byte_length: input.byte_length, next_offset: started?.next_offset ?? 0 };
    },
    async putPart(upload, offset, bytes) {
      for (let at = 0; at < bytes.byteLength; at += PIECE_BYTES) {
        await door.files('write_file_piece', { upload_id: upload.upload_id, name: upload.name, offset: offset + at,
          content_base64: Buffer.from(bytes.subarray(at, at + PIECE_BYTES)).toString('base64') });
      }
      if (offset + bytes.byteLength !== upload.byte_length) return 'growing';
      const finished = await door.files('write_file_finish', { upload_id: upload.upload_id, name: upload.name });
      if (!finished?.identity) throw new CameraWall('not-confirmed', 'Files did not acknowledge the completed recording.', 502);
      return 'stored';
    },
  };
}

async function readSources(files) {
  // A Files transport or permission failure is not an empty source list. Keep it
  // visible so a camera update cannot replace sources it could not read.
  const text = await files.readText(SOURCES_FILE);
  try {
    const parsed = JSON.parse(text ?? '{}');
    return Array.isArray(parsed.sources) ? parsed.sources : [];
  } catch { return []; }
}
const writeSources = (files, sources) => files.writeText(SOURCES_FILE, `${JSON.stringify({ sources }, null, 2)}\n`);

/** Makes sure Stream tells this Worker when a recording is ready. An account has one Stream webhook: another address
 *  already there is left alone (recordings are then found by `fileRecordings`), never overwritten. */
async function ensureWebhook({ api, kv, origin }) {
  const wanted = `${origin}${WEBHOOK_PATH}`;
  const current = await api('GET', '/webhook').catch(error => { if (error instanceof CameraWall && error.code === 'stream-refused') return null; throw error; });
  const have = current?.notificationUrl || '';
  if (have && have !== wanted) return { webhook: 'another-address-in-use' };
  if (have === wanted && await kv.get(WEBHOOK_SECRET_KEY)) return { webhook: 'ready' };
  const set = await api('PUT', '/webhook', { notificationUrl: wanted });
  if (set?.secret) await kv.put(WEBHOOK_SECRET_KEY, set.secret);
  return { webhook: 'ready' };
}

/** A new camera: its live input at Stream, its ingest address and key kept, and its picture and folder named on the
 *  Always recording screen. Asking again for a name already made answers that camera and makes nothing. */
export async function createCamera({ env, userId, name, origin, kv, files, fetchImpl = fetch, now = () => new Date() }) {
  const label = cleanName(name);
  const id = slug(label);
  if (!label || !CAMERA_ID.test(id)) throw new CameraWall('name', 'Name the camera in a few plain words, like "Front court".', 400);
  const list = (await kv.get(listKey(userId), 'json')) ?? [];
  const known = list.find(item => item.camera_id === id);
  if (known) return { ...(await describeCamera({ kv, uid: known.uid })), already: true };
  const api = streamApi(env, fetchImpl);
  const hook = await ensureWebhook({ api, kv, origin });
  const made = await api('POST', '/live_inputs', {
    meta: { name: `Trillion camera: ${label}`, trillion_user: userId, trillion_camera: id },
    // A broadcast that drops for up to five minutes (a phone hotspot moving) stays one recording.
    recording: { mode: 'automatic', timeoutSeconds: 300, requireSignedURLs: false },
  });
  const uid = made?.uid;
  if (!UID.test(String(uid ?? '')) || !made.rtmps?.url || !made.rtmps?.streamKey) throw new CameraWall('stream-shape', 'Cloudflare Stream answered without an ingest address. Nothing was kept.', 502);
  const host = hostOf(made.webRTCPlayback?.url ?? '') ?? (env.CLOUDFLARE_STREAM_HOST ? hostOf(`https://${env.CLOUDFLARE_STREAM_HOST}/`) : null);
  const record = {
    user_id: userId, camera_id: id, name: label, rtmps_url: made.rtmps.url, rtmps_key: made.rtmps.streamKey,
    srt_url: made.srt?.url ?? null, srt_stream_id: made.srt?.streamId ?? null, srt_passphrase: made.srt?.passphrase ?? null,
    stream_host: host, playback_url: playbackFor(host, uid), created_at: now().toISOString(),
  };
  await kv.put(inputKey(uid), JSON.stringify(record));
  await kv.put(listKey(userId), JSON.stringify([...list, { camera_id: id, uid }]));
  const sources = (await readSources(files)).filter(source => source.id !== id);
  sources.push({
    id, kind: 'hls', label, playback_url: record.playback_url, clips_folder: RECORDINGS_FOLDER,
    connection: 'its own mobile network', ingest_url: record.rtmps_url,
  });
  await writeSources(files, sources);
  return { ...(await describeCamera({ kv, uid })), ...hook };
}

/** What may be told to an AI or drawn: never the key. */
export async function describeCamera({ kv, uid }) {
  const record = await kv.get(inputKey(uid), 'json');
  if (!record) throw new CameraWall('unknown-camera', 'That camera is not here.', 404);
  const last = (await kv.get(filingKey(`last:${uid}`), 'json')) ?? null;
  return {
    camera_id: record.camera_id, name: record.name, live_input: uid,
    ingest: { rtmps_url: record.rtmps_url, srt_url: record.srt_url },
    key_stored: true, key_hint: `ends ${String(record.rtmps_key).slice(-4)}`,
    watch_url: record.playback_url, recordings_go_to: `${RECORDINGS_FOLDER}/{day}/`, last_filed: last,
    how_to_connect: 'On the camera, open its network streaming (RTMPS) settings: set the URL above and paste the key, which the Always recording screen copies with "Copy camera key". Then turn streaming on in the camera\'s menu.',
  };
}

export async function listCameras({ kv, userId }) {
  const list = (await kv.get(listKey(userId), 'json')) ?? [];
  return { cameras: await Promise.all(list.map(item => describeCamera({ kv, uid: item.uid }))) };
}

/** The ingest address and key for the camera's own owner, for the Always recording screen's session only. */
export async function revealCamera({ kv, userId, cameraId }) {
  const list = (await kv.get(listKey(userId), 'json')) ?? [];
  const item = list.find(entry => entry.camera_id === cameraId);
  const record = item ? await kv.get(inputKey(item.uid), 'json') : null;
  if (!record || record.user_id !== userId) throw new CameraWall('unknown-camera', 'That camera is not here.', 404);
  return { camera_id: cameraId, rtmps_url: record.rtmps_url, stream_key: record.rtmps_key, srt_url: record.srt_url };
}

/** Removes a camera: its live input at Stream and its entry on the screen. Recordings already in Files stay. */
export async function removeCamera({ env, userId, cameraId, kv, files, fetchImpl = fetch }) {
  const list = (await kv.get(listKey(userId), 'json')) ?? [];
  const item = list.find(entry => entry.camera_id === cameraId);
  if (!item) throw new CameraWall('unknown-camera', 'That camera is not here.', 404);
  const api = streamApi(env, fetchImpl);
  await api('DELETE', `/live_inputs/${item.uid}`).catch(error => { if (!(error instanceof CameraWall && error.status === 404)) throw error; });
  await kv.delete(inputKey(item.uid));
  await kv.put(listKey(userId), JSON.stringify(list.filter(entry => entry.camera_id !== cameraId)));
  await writeSources(files, (await readSources(files)).filter(source => source.id !== cameraId));
  return { removed: cameraId, kept: `${RECORDINGS_FOLDER} is untouched.` };
}

/** Account erasure: every camera the account made stops being an ingest point and leaves no key behind. For each live
 *  input on the account's list, its recordings still at Stream and their filing marks go first, then the input itself
 *  (its ingest key and passphrase with it), then its record and last-filed mark; the list goes last, so a deletion cut
 *  off part way finds the same cameras again and finishes them. A camera already gone at Stream counts as gone. The
 *  account-wide webhook secret is not this account's and stays. */
export async function forgetCameras({ env, userId, kv, fetchImpl = fetch }) {
  const list = (await kv.get(listKey(userId), 'json')) ?? [];
  if (!list.length) { await kv.delete(listKey(userId)); return { cameras: 0, recordings: 0 }; }
  const api = streamApi(env, fetchImpl);
  const gone = error => { if (!(error instanceof CameraWall && error.status === 404)) throw error; return null; };
  let recordings = 0;
  for (const { uid } of list) {
    if (!UID.test(String(uid ?? ''))) continue;
    const videos = (await api('GET', `/live_inputs/${uid}/videos`).catch(gone)) ?? [];
    for (const video of videos) {
      if (!UID.test(String(video?.uid ?? ''))) continue;
      await api('DELETE', `/${video.uid}`).catch(gone);
      await kv.delete(filingKey(video.uid));
      recordings += 1;
    }
    await api('DELETE', `/live_inputs/${uid}`).catch(gone);
    await kv.delete(inputKey(uid));
    await kv.delete(filingKey(`last:${uid}`));
  }
  await kv.delete(listKey(userId));
  return { cameras: list.length, recordings };
}

// ---- finished recordings into Files --------------------------------------------------------------------------------

const two = value => String(value).padStart(2, '0');
function recordingName(video, label, uid) {
  const at = new Date(Date.parse(video.created ?? '') || Date.now());
  const day = at.toISOString().slice(0, 10);
  const time = `${two(at.getUTCHours())}.${two(at.getUTCMinutes())}.${two(at.getUTCSeconds())}`;
  return `${RECORDINGS_FOLDER}/${day}/${time} ${label} ${uid.slice(0, 8)}.mp4`;
}

async function downloadAddress(api, uid) {
  let download = (await api('GET', `/${uid}/downloads`).catch(() => null))?.default;
  if (!download) download = (await api('POST', `/${uid}/downloads`))?.default;
  return download?.status === 'ready' && download.url ? download.url : null;
}

async function sizeOf(address, fetchImpl) {
  const head = await fetchImpl(address, { method: 'HEAD' });
  const length = Number(head.headers.get('content-length'));
  if (head.ok && Number.isFinite(length) && length > 0) return length;
  const probe = await fetchImpl(address, { headers: { range: 'bytes=0-0' } });
  const total = Number(/\/(\d+)$/.exec(probe.headers.get('content-range') ?? '')?.[1]);
  await probe.body?.cancel();
  if (Number.isFinite(total) && total > 0) return total;
  throw new CameraWall('no-length', 'Stream did not say how long the recording file is.', 502);
}

/** Copies one finished Stream recording into Files, as far as the time allows. Answers 'filed', 'more' (call again;
 *  it resumes), 'waiting' (the MP4 is not ready at Stream yet) or 'ignored' (not a recording of one of our cameras). */
export async function fileRecording({ env, uid, kv, files, fetchImpl = fetch, budgetMs = FILING_BUDGET_MS, now = Date.now }) {
  if (!UID.test(uid)) return { state: 'ignored' };
  const progress = await kv.get(filingKey(uid), 'json');
  if (progress?.state === 'filed') return { state: 'filed', name: progress.name };
  const api = streamApi(env, fetchImpl);
  const video = await api('GET', `/${uid}`);
  const input = liveInputOf(video);
  const owner = input ? await kv.get(inputKey(input), 'json') : null;
  if (!owner) return { state: 'ignored' };
  if (!video.readyToStream || video.status?.state !== 'ready') return { state: 'waiting' };
  const address = await downloadAddress(api, uid);
  if (!address) return { state: 'waiting' };
  const total = await sizeOf(address, fetchImpl);
  const name = progress?.name ?? recordingName(video, owner.name, uid);
  let send = progress?.send_bytes_to;
  let offset = progress?.offset ?? 0;
  if (!send || progress.byte_length !== total) { send = await files.startUpload({ name, byte_length: total, media_type: 'video/mp4' }); offset = 0; }
  const began = now();
  while (offset < total) {
    const ranged = offset > 0;
    const response = await fetchImpl(address, ranged ? { headers: { range: `bytes=${offset}-` } } : {});
    if (ranged && response.status !== 206) {
      await response.body?.cancel();
      await kv.delete(filingKey(uid));
      return { state: 'more', note: 'starting over: the download cannot be ranged' };
    }
    if (!response.ok || !response.body) throw new CameraWall('download', `Stream would not send the recording file (status ${response.status}).`, 502);
    const reader = response.body.getReader();
    let held = [];
    let heldBytes = 0;
    const flush = async () => {
      if (!heldBytes) return;
      const bytes = new Uint8Array(heldBytes);
      let at = 0;
      for (const piece of held) { bytes.set(piece, at); at += piece.byteLength; }
      held = []; heldBytes = 0;
      let state;
      try { state = await files.putPart(send, offset, bytes); } catch (error) {
        // An address that expired is dropped so the next call starts a new upload from the first byte.
        if (error?.status === 401 || error?.status === 403 || error?.status === 404) await kv.delete(filingKey(uid));
        throw error;
      }
      offset += bytes.byteLength;
      if (offset === total && state !== 'stored' && state !== 'present') throw new CameraWall('not-confirmed', `Trillion has not confirmed the completed recording: ${state}`, 502);
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        held.push(value); heldBytes += value.byteLength;
        if (heldBytes >= PART_BYTES) {
          await flush();
          if (offset < total && now() - began > budgetMs) { await reader.cancel(); break; }
        }
      }
      await flush();
    } finally { reader.releaseLock?.(); }
    if (offset < total) {
      await kv.put(filingKey(uid), JSON.stringify({ state: 'filing', name, byte_length: total, send_bytes_to: send, offset }));
      if (now() - began > budgetMs) return { state: 'more', offset, of: total };
    }
  }
  await kv.put(filingKey(uid), JSON.stringify({ state: 'filed', name, bytes: total, at: new Date(now()).toISOString() }));
  await kv.put(filingKey(`last:${input}`), JSON.stringify({ name, bytes: total }));
  // Only the acknowledged Files copy survives; Stream's copy was a way to carry the bytes.
  await api('DELETE', `/${uid}`).catch(() => {});
  return { state: 'filed', name, bytes: total };
}

/** Files every ready recording of the account's cameras that is not filed yet (the webhook's safety net, and what
 *  the Always recording screen asks for when it opens). */
export async function fileRecordings({ env, userId, kv, files, fetchImpl = fetch, budgetMs }) {
  const list = (await kv.get(listKey(userId), 'json')) ?? [];
  const api = streamApi(env, fetchImpl);
  const results = [];
  const began = Date.now();
  for (const item of list) {
    const videos = (await api('GET', `/live_inputs/${item.uid}/videos`)) ?? [];
    for (const video of videos) {
      if (video.status?.state !== 'ready' || !video.readyToStream) continue;
      const left = budgetMs === undefined ? {} : { budgetMs: Math.max(0, budgetMs - (Date.now() - began)) };
      results.push({ video: video.uid, ...(await fileRecording({ env, uid: video.uid, kv, files, fetchImpl, ...left })) });
    }
  }
  const count = state => results.filter(result => result.state === state).length;
  return { filed: count('filed'), more: count('more'), waiting: count('waiting'), results };
}

// ---- the webhook ---------------------------------------------------------------------------------------------------

const toHex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const sameText = (left, right) => {
  if (left.length !== right.length) return false;
  let different = 0;
  for (let at = 0; at < left.length; at += 1) different |= left.charCodeAt(at) ^ right.charCodeAt(at);
  return different === 0;
};

/** Stream's Webhook-Signature (`time=UNIX,sig1=HEX`): HMAC-SHA256 of `TIME.RAWBODY` under the webhook secret. */
export async function webhookSignatureHolds({ header, body, key, nowSeconds = Math.floor(Date.now() / 1000) }) {
  const parts = Object.fromEntries(String(header ?? '').split(',').map(part => part.split('=')).filter(pair => pair.length === 2));
  const time = Number(parts.time);
  if (!parts.sig1 || !Number.isFinite(time) || Math.abs(nowSeconds - time) > WEBHOOK_MAX_AGE_SECONDS) return false;
  const imported = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = await crypto.subtle.sign('HMAC', imported, new TextEncoder().encode(`${parts.time}.${body}`));
  return sameText(toHex(signed), String(parts.sig1));
}

/** Stream calls this when a video is ready. Answers at once and files the recording after the answer (`ctx.waitUntil`). */
export async function receiveStreamWebhook(request, { env, ctx, kv, filesFor, fetchImpl = fetch }) {
  if (request.method !== 'POST') return Response.json({ error: 'Use POST for Stream notices.' }, { status: 405 });
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > WEBHOOK_MAX_BYTES) return Response.json({ error: 'Notice is too large.' }, { status: 413 });
  const body = await request.text();
  if (body.length > WEBHOOK_MAX_BYTES) return Response.json({ error: 'Notice is too large.' }, { status: 413 });
  const key = await kv.get(WEBHOOK_SECRET_KEY);
  if (key && !await webhookSignatureHolds({ header: request.headers.get('webhook-signature'), body, key })) {
    return Response.json({ error: 'The notice is not signed by Stream.' }, { status: 401 });
  }
  let notice;
  try { notice = JSON.parse(body); } catch { return Response.json({ error: 'Notice is not JSON.' }, { status: 400 }); }
  const uid = notice?.uid;
  if (typeof uid !== 'string' || !UID.test(uid)) return Response.json({ received: true, ignored: 'No video in this notice.' });
  // Which account's Files it goes to comes from the live input the video is re-read to belong to, never from the notice.
  const work = (async () => {
    const video = await streamApi(env, fetchImpl)('GET', `/${uid}`);
    const input = liveInputOf(video);
    const owner = input ? await kv.get(inputKey(input), 'json') : null;
    if (!owner) return;
    await fileRecording({ env, uid, kv, files: filesFor(owner.user_id), fetchImpl });
  })().catch(error => console.error('camera recording:', error instanceof CameraWall ? error.code : 'failed'));
  ctx.waitUntil(work);
  return Response.json({ received: true }, { status: 202 });
}

// ---- the API the tools and the screen share ----------------------------------------------------------------------

export const isCameraApiPath = path => /^\/(?:mcp|work)\/api\/cameras(?:\/(?:file|[a-z0-9][a-z0-9-]{0,39}(?:\/key)?))?$/.test(path);

const refuse = (error, status) => Response.json({ error }, { status });

/** /mcp/api/cameras and /work/api/cameras (the same owner for an AI's tool and the Always recording screen).
 *  `browser` is true only for the signed-in web page: the one road a key leaves the Worker. */
export async function answerCameraApi(request, { env, userId, ctx, origin, browser = false, fetchImpl = fetch, door, files = accountFiles({ door }) }) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/(?:mcp|work)\/api\/cameras/, '');
  const kv = env.APP_KV;
  const operator = Boolean(env.OPERATOR_ACCOUNT_ID) && userId === env.OPERATOR_ACCOUNT_ID;
  try {
    if (path === '' && request.method === 'GET') {
      // Opening the screen also files any recording the webhook missed.
      if (operator && ctx) ctx.waitUntil(fileRecordings({ env, userId, kv, files, fetchImpl, budgetMs: FILING_BUDGET_MS }).catch(() => {}));
      return Response.json(await listCameras({ kv, userId }));
    }
    if (!operator) return refuse('Network cameras are kept by the account that runs this Trillion.', 403);
    if (path === '' && request.method === 'POST') {
      const input = await request.json().catch(() => ({}));
      return Response.json(await createCamera({ env, userId, name: input?.name, origin, kv, files, fetchImpl }));
    }
    if (path === '/file' && request.method === 'POST') return Response.json(await fileRecordings({ env, userId, kv, files, fetchImpl, budgetMs: 40_000 }));
    const key = path.match(/^\/([a-z0-9][a-z0-9-]*)\/key$/);
    if (key && request.method === 'GET') {
      if (!browser) return refuse('A camera key is shown only on Trillion\'s own Always recording screen, never to an AI.', 403);
      return Response.json(await revealCamera({ kv, userId, cameraId: key[1] }), { headers: { 'cache-control': 'no-store' } });
    }
    const one = path.match(/^\/([a-z0-9][a-z0-9-]*)$/);
    if (one && request.method === 'DELETE') return Response.json(await removeCamera({ env, userId, cameraId: one[1], kv, files, fetchImpl }));
    return refuse('Not allowed', 405);
  } catch (error) {
    if (error instanceof CameraWall) return refuse(error.message, error.status);
    console.error('cameras:', String(error?.message ?? error).slice(0, 200));
    return refuse('Trillion could not finish that camera step. Try again.', 500);
  }
}
