// Draft Marketplace camera package. Provider transport, account state, Files access,
// admission checks and continuations are injected as named host capabilities.
const API = '/accounts/current/stream';
const ROOT = 'camera-marketplace:v1';
const RECORDINGS = '/Recordings/Cameras';
const PART_BYTES = 8 * 1024 * 1024;
const WEBHOOK_SECRET = `${ROOT}:webhook-secret`;
const UID = /^[a-f0-9]{32}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const json = value => JSON.stringify(value);
const fail = (message, code = 'camera_failed', status = 502) => Object.assign(new Error(message), { code, status });
const clean = value => String(value ?? '').replace(/[\\/\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
const slug = value => clean(value).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const inputKey = uid => `${ROOT}:input:${uid}`;
const cameraPrefix = `${ROOT}:camera:`;
const cameraKey = id => `${cameraPrefix}${id}`;
const intentKey = id => `${ROOT}:intent:${id}`;
const filingKey = uid => `${ROOT}:filing:${uid}`;
const lastKey = uid => `${ROOT}:last:${uid}`;

async function call(host, capability, input, requestKey = null) {
  const invoke = host?.[capability];
  if (typeof invoke !== 'function') throw fail(`The Marketplace host capability ${capability} is unavailable.`, 'host_unavailable', 503);
  if (requestKey === null && capability === 'state' && !['get', 'scan'].includes(input.operation))
    requestKey = json([input.operation, input.key, input.expected_revision ?? null, input.value?.state ?? null, input.value?.offset ?? null]);
  if (requestKey === null && capability === 'stream' && !['GET', 'HEAD'].includes(input.method))
    requestKey = json([input.method, input.path, input.body?.meta?.trillion_camera ?? null]);
  if (requestKey === null && (capability === 'continuation' || capability === 'files')) requestKey = input.request_key ?? null;
  return invoke(input, requestKey === null ? undefined : { request_key: requestKey });
}
const state = (host, operation, key, value, options = {}) => call(host, 'state', { operation, key, ...(value === undefined ? {} : { value }), ...options });
const accountOf = async host => {
  const principal = await call(host, 'current', { operation: 'camera:current-principal', purpose: 'network-camera' });
  if (!principal || typeof principal.account_id !== 'string' || !principal.account_id) throw fail('The current account is unavailable.', 'account_unavailable', 401);
  return principal.account_id;
};
const current = (host, purpose, facts = {}) => call(host, 'current', { operation: purpose, ...facts });

async function stream(host, method, path, body) {
  let response;
  const target = /^https:\/\//i.test(path) ? path : `${API}${path}`;
  try { response = await call(host, 'stream', { method, path: target, ...(body === undefined ? {} : { body }) }); }
  catch (error) { throw error; }
  if (response?.ok === false || Number(response?.status) >= 400) {
    const status = Number(response.status) || 502;
    const code = response.error?.code ?? response.code ?? 'stream_refused';
    throw fail(`The connected Stream service refused the request (${code}).`, String(code), status === 403 || status === 401 ? 403 : status === 404 ? 404 : 502);
  }
  return Object.hasOwn(response ?? {}, 'result') ? response.result : response;
}

async function readList(host, after = null, limit = 100) {
  const page = await call(host, 'state', { operation: 'scan', prefix: cameraPrefix, after, limit });
  if (!Array.isArray(page?.entries)) throw fail('The camera state scan is unavailable.', 'camera_state_unavailable', 503);
  const cameras = page.entries.map(entry => entry.value).filter(row => row && row.status !== 'removing' &&
    ID.test(String(row.camera_id ?? '')) && UID.test(String(row.uid ?? '')));
  return { cameras, next: page.next ?? null };
}
async function saveCamera(host, record) {
  const key = cameraKey(record.camera_id), prior = await state(host, 'get', key);
  if (prior?.value?.status === 'removing') throw fail('This camera is being removed and cannot be reactivated yet.', 'camera_removing', 409);
  if (prior && prior.value?.uid !== record.uid) throw fail('A different camera already owns this name.', 'camera_name_conflict', 409);
  const result = await call(host, 'state', { operation: 'compareAndSet', key, expected_revision: prior?.revision ?? null,
    value: { camera_id: record.camera_id, uid: record.uid, name: record.name, user_id: record.user_id } });
  if (!result?.applied) throw fail('Camera state changed during this operation. Retry to reconcile it.', 'camera_state_conflict', 409);
}
async function readInput(host, uid) {
  const row = await state(host, 'get', inputKey(uid), undefined, { private: true, secret: true });
  return row?.value ?? row ?? null;
}
async function saveInput(host, record) {
  await state(host, 'put', inputKey(record.uid), record, { private: true, secret: true });
}
async function ensureWebhook(host) {
  const address = await current(host, 'camera:webhook-address');
  if (typeof address?.callback_url !== 'string' || !address.callback_url.startsWith('https://')) return 'host-continuation-required';
  // A failed or incomplete read does not establish that the provider endpoint
  // is unused. Preserve its current configuration by refusing before any PUT.
  const existing = await stream(host, 'GET', '/webhook');
  if (typeof existing?.notificationUrl !== 'string') throw fail('The connected service did not confirm its current webhook address; it was left unchanged.', 'webhook_state_unknown', 503);
  const configured = existing.notificationUrl;
  if (configured && configured !== address.callback_url) return 'another-address-in-use';
  const held = await state(host, 'get', WEBHOOK_SECRET, undefined, { private: true, secret: true });
  const heldKey = held?.value ?? held;
  if (configured === address.callback_url && typeof heldKey === 'string' && heldKey) return 'ready';
  const answer = await stream(host, 'PUT', '/webhook', { notificationUrl: address.callback_url });
  if (typeof answer?.secret === 'string' && answer.secret) await state(host, 'put', WEBHOOK_SECRET, answer.secret, { private: true, secret: true });
  return typeof answer?.secret === 'string' && answer.secret ? 'ready' : 'signing-secret-unavailable';
}
function hostOf(address) {
  try { const value = new URL(address); return /^customer-[a-z0-9]+\.cloudflarestream\.com$/.test(value.hostname) ? value.hostname : null; }
  catch { return null; }
}
const playback = (host, uid) => host ? `https://${host}/${uid}/manifest/video.m3u8` : null;

async function describe(host, record) {
  const last = await state(host, 'get', lastKey(record.uid));
  return {
    camera_id: record.camera_id, name: record.name, live_input: record.uid,
    ingest: { rtmps_url: record.rtmps_url, srt_url: record.srt_url },
    key_stored: true, key_hint: `ends ${String(record.rtmps_key).slice(-4)}`,
    watch_url: record.playback_url, recordings_go_to: `${RECORDINGS}/{day}/`, last_filed: last?.value ?? last ?? null,
    how_to_connect: 'On the camera, open its network streaming (RTMPS) settings: set the URL above and paste the key, which the Always recording screen copies with “Copy camera key”. Then turn streaming on in the camera menu.',
  };
}

async function reconcileCreate(host, account, id) {
  const intent = await state(host, 'get', intentKey(id));
  const row = intent?.value ?? intent;
  if (!row) return null;
  if (row.account !== account || row.camera_id !== id) return { unknown: true };
  if (row.state === 'complete') {
    const saved = await readInput(host, row.uid);
    return saved?.user_id === account ? saved : { unknown: true };
  }
  if (row.state !== 'dispatching' && row.state !== 'unknown') return null;
  // After uncertain dispatch, search for the deterministic metadata before any new POST.
  const inputs = await stream(host, 'GET', '/live_inputs');
  const match = (Array.isArray(inputs) ? inputs : inputs?.data ?? []).find(item =>
    item?.meta?.trillion_user === account && item?.meta?.trillion_camera === id && UID.test(String(item.uid ?? '')));
  if (!match) return { unknown: true };
  const detail = await stream(host, 'GET', `/live_inputs/${match.uid}`);
  const rtmps = detail?.rtmps ?? match.rtmps;
  if (!rtmps?.streamKey || !rtmps?.url) return { unknown: true };
  return { uid: match.uid, user_id: account, name: row.name, camera_id: id, rtmps_url: rtmps.url, rtmps_key: rtmps.streamKey,
    srt_url: detail?.srt?.url ?? match.srt?.url ?? null, srt_stream_id: detail?.srt?.streamId ?? match.srt?.streamId ?? null,
    srt_passphrase: detail?.srt?.passphrase ?? match.srt?.passphrase ?? null,
    playback_url: playback(hostOf(detail?.webRTCPlayback?.url ?? match.webRTCPlayback?.url ?? ''), match.uid), created_at: row.created_at };
}

async function connect(host, account, name) {
  const label = clean(name), id = slug(label);
  if (!label || !ID.test(id)) throw fail('Name the camera in a few plain words, like “Front court”.', 'camera_name', 400);
  await current(host, 'camera:create', { camera_id: id });
  const existing = await state(host, 'get', cameraKey(id));
  if (existing?.value?.status === 'removing') throw fail('This camera is being removed. Retry after removal finishes.', 'camera_removing', 409);
  if (existing?.value) {
    const record = await readInput(host, existing.value.uid);
    if (!record) throw fail('The saved camera record is missing; no new Stream input was created.', 'camera_state_missing', 409);
    return { ...(await describe(host, record)), already: true };
  }
  const prior = await reconcileCreate(host, account, id);
  if (prior?.unknown) throw fail('The original Stream create may have succeeded. Its result is still unknown; no second input was created.', 'camera_create_unknown', 409);
  let record = prior;
  let webhook = null;
  if (!record) {
    const intent = { state: 'dispatching', account, camera_id: id, name: label, created_at: new Date().toISOString() };
    const claim = await call(host, 'state', { operation: 'compareAndSet', key: intentKey(id), expected_revision: null, value: intent });
    if (!claim?.applied) throw fail('Another connect is creating this camera. Retry to reconcile its result.', 'camera_create_in_progress', 409);
    try { webhook = await ensureWebhook(host); }
    catch (error) {
      const released = await call(host, 'state', { operation: 'delete', key: intentKey(id), expected_revision: claim.revision });
      if (!released?.deleted) throw fail('Webhook setup failed and the camera creation claim could not be released safely.', 'camera_state_conflict', 409);
      throw error;
    }
    // The intent is durable before POST. If the host loses the reply, retry reconciles and never redispatches.
    let made;
    try {
      made = await stream(host, 'POST', '/live_inputs', {
        meta: { name: `Trillion camera: ${label}`, trillion_user: account, trillion_camera: id },
        recording: { mode: 'automatic', timeoutSeconds: 300, requireSignedURLs: false },
      });
    } catch (error) {
      const marked = await call(host, 'state', { operation: 'compareAndSet', key: intentKey(id), expected_revision: claim.revision,
        value: { ...intent, state: 'unknown' } });
      if (!marked?.applied) throw fail('The Stream create result is unknown. The intent remains protected against a second create.', 'camera_create_unknown', 409);
      throw error;
    }
    const uid = made?.uid;
    if (!UID.test(String(uid ?? '')) || !made.rtmps?.url || !made.rtmps?.streamKey) {
      const marked = await call(host, 'state', { operation: 'compareAndSet', key: intentKey(id), expected_revision: claim.revision,
        value: { ...intent, state: 'unknown' } });
      if (!marked?.applied) throw fail('Stream returned an incomplete input and its intent could not be updated; no retry was dispatched.', 'camera_create_unknown', 409);
      throw fail('Stream returned an incomplete camera input. Its create result is unknown; no retry was dispatched.', 'camera_create_unknown', 502);
    }
    const h = hostOf(made.webRTCPlayback?.url ?? '');
    record = { uid, user_id: account, camera_id: id, name: label, rtmps_url: made.rtmps.url, rtmps_key: made.rtmps.streamKey,
      srt_url: made.srt?.url ?? null, srt_stream_id: made.srt?.streamId ?? null, srt_passphrase: made.srt?.passphrase ?? null,
      playback_url: playback(h, uid), created_at: intent.created_at };
  }
  if (prior) {
    if (await accountOf(host) !== account) throw fail('The current account changed before the recovered camera could be adopted.', 'account_unavailable', 401);
    await current(host, 'camera:create', { camera_id: id, phase: 'reconcile' });
    webhook = await ensureWebhook(host);
  }
  // Persist provider secrets before the per-camera record so a retry can complete the projection.
  await saveInput(host, record);
  const intentRow = await state(host, 'get', intentKey(id));
  const intentRevision = intentRow?.revision;
  if (intentRow?.value?.state !== 'complete') {
    const complete = await call(host, 'state', { operation: 'compareAndSet', key: intentKey(id), expected_revision: intentRevision,
      value: { state: 'complete', account, uid: record.uid, camera_id: id, name: label } });
    if (!complete?.applied) throw fail('Camera state changed while saving the input. Retry to reconcile it.', 'camera_state_conflict', 409);
  }
  await saveCamera(host, record);
  await current(host, 'camera:create', { camera_id: id });
  return { ...(await describe(host, record)), webhook };
}

async function list(host, input) {
  const limit = Math.min(100, Math.max(1, Number.isInteger(input.limit) ? input.limit : 50));
  const page = await readList(host, input.after ?? null, limit), cameras = [];
  for (const item of page.cameras) {
    const record = await readInput(host, item.uid);
    if (record) cameras.push(await describe(host, record));
  }
  return { cameras, next: page.next };
}

async function remove(host, account, cameraId) {
  if (typeof cameraId !== 'string' || !ID.test(cameraId)) throw fail('Name the camera to remove.', 'camera_name', 400);
  await current(host, 'camera:delete', { camera_id: cameraId });
  const item = await state(host, 'get', cameraKey(cameraId));
  const camera = item?.value;
  if (!camera) throw fail('That camera is not here.', 'unknown_camera', 404);
  // State keys are isolated to the current account namespace. New records also
  // carry the owner explicitly; reject any present owner mismatch before resume.
  if (camera.user_id && camera.user_id !== account) throw fail('That camera is not here.', 'unknown_camera', 404);
  let removing = { revision: item.revision };
  let record = null;
  if (camera.status !== 'removing') {
    record = await readInput(host, camera.uid);
    if (!record || record.user_id !== account) throw fail('That camera is not here.', 'unknown_camera', 404);
    removing = await call(host, 'state', { operation: 'compareAndSet', key: cameraKey(cameraId), expected_revision: item.revision,
      value: { ...camera, user_id: account, status: 'removing' } });
    if (!removing?.applied) throw fail('Camera state changed during removal. Retry before deleting it.', 'camera_state_conflict', 409);
  } else if (!UID.test(String(camera.uid ?? ''))) {
    throw fail('The saved removal record is incomplete; it was left untouched.', 'camera_state_invalid', 409);
  } else {
    record = await readInput(host, camera.uid);
    if (camera.user_id) {
      if (record && record.user_id !== account) throw fail('That camera is not here.', 'unknown_camera', 404);
    } else {
      if (!record || record.user_id !== account) throw fail('The saved removal record has no owner proof; it was left untouched.', 'camera_state_invalid', 409);
      removing = await call(host, 'state', { operation: 'compareAndSet', key: cameraKey(cameraId), expected_revision: item.revision,
        value: { ...camera, user_id: account, status: 'removing' } });
      if (!removing?.applied) throw fail('Camera ownership changed during removal recovery.', 'camera_state_conflict', 409);
    }
  }
  if (record && record.user_id !== account) throw fail('That camera is not here.', 'unknown_camera', 404);
  try { await stream(host, 'DELETE', `/live_inputs/${camera.uid}`); }
  catch (error) { if (error.status !== 404) throw error; }
  if (record) {
    const inputDeleted = await state(host, 'delete', inputKey(camera.uid), undefined, { private: true, secret: true });
    if (!inputDeleted?.deleted) throw fail('The provider input is gone, but its private key record could not be cleared.', 'camera_state_conflict', 409);
  }
  const intent = await state(host, 'get', intentKey(cameraId));
  if (intent && (intent.value?.uid !== camera.uid || intent.value?.camera_id !== cameraId || intent.value?.state !== 'complete')) {
    throw fail('A newer or incomplete camera intent exists; removal is paused to protect it.', 'camera_state_conflict', 409);
  }
  if (intent) {
    const cleared = await call(host, 'state', { operation: 'delete', key: intentKey(cameraId), expected_revision: intent.revision });
    if (!cleared?.deleted) throw fail('The camera intent changed during removal; cleanup is incomplete.', 'camera_state_conflict', 409);
  }
  const removed = await call(host, 'state', { operation: 'delete', key: cameraKey(cameraId), expected_revision: removing.revision });
  if (!removed?.deleted) throw fail('The camera changed during removal; cleanup is incomplete.', 'camera_state_conflict', 409);
  await current(host, 'camera:delete', { camera_id: cameraId });
  return { removed: cameraId, kept: `${RECORDINGS} is untouched.` };
}

const videoInput = video => { const uid = video?.liveInput?.uid ?? video?.liveInput; return UID.test(String(uid ?? '')) ? uid : null; };
const pad = value => String(value).padStart(2, '0');
function targetName(video, camera, uid) {
  const milliseconds = Date.parse(video.created ?? '');
  if (!Number.isFinite(milliseconds)) return `${RECORDINGS}/Undated/${camera.name} ${uid}.mp4`;
  const time = new Date(milliseconds);
  const date = time.toISOString();
  return `${RECORDINGS}/${date.slice(0, 10)}/${pad(time.getUTCHours())}.${pad(time.getUTCMinutes())}.${pad(time.getUTCSeconds())} ${camera.name} ${uid}.mp4`;
}
async function downloadUrl(host, uid) {
  let d;
  try { d = await stream(host, 'GET', `/${uid}/downloads`); } catch { /* request it below */ }
  if (!d?.default) d = await stream(host, 'POST', `/${uid}/downloads`);
  return d?.default?.status === 'ready' ? d.default.url : null;
}
async function callFiles(host, operation, input, requestKey = null) { return call(host, 'files', { operation, ...input }, requestKey); }

async function finishFiling(host, account, uid, progress) {
  const result = { state: 'filed', name: progress.name, identity: progress.identity, bytes: progress.bytes };
  // The completed copy survives a failed provider cleanup. A retry verifies that
  // same copy and provider input before deleting; it never uploads a second file.
  if (progress.account !== account || !UID.test(String(progress.input_uid ?? ''))) return { ...result, cleanup: 'pending' };
  const stored = await callFiles(host, 'describe', { name: progress.name });
  if (stored?.stored !== true || stored.identity !== progress.identity || stored.byte_length !== progress.bytes)
    throw fail('The filed recording no longer has its confirmed identity and length; its provider copy was left untouched.', 'not_confirmed');
  await call(host, 'state', { operation: 'put', key: lastKey(progress.input_uid), value: { name: progress.name, identity: progress.identity, bytes: progress.bytes } }, `recording:${uid}:last-summary`);
  let video;
  try { video = await stream(host, 'GET', `/${uid}`); }
  catch (error) { if (error.status === 404) return { ...result, cleanup: 'complete' }; throw error; }
  if (videoInput(video) !== progress.input_uid) throw fail('The provider recording no longer matches its filed camera.', 'camera_state_conflict', 409);
  await current(host, 'camera:file', { uid });
  try { await stream(host, 'DELETE', `/${uid}`); }
  catch (error) { if (error.status !== 404) return { ...result, cleanup: 'pending' }; }
  return { ...result, cleanup: 'complete' };
}

async function fileOne(host, account, uid, budgetMs = 20_000) {
  if (!UID.test(String(uid))) return { state: 'ignored' };
  await current(host, 'camera:file', { uid });
  const progressValue = await state(host, 'get', filingKey(uid));
  const progress = progressValue?.value ?? progressValue;
  if (progress?.state === 'filed') return finishFiling(host, account, uid, progress);
  const video = await stream(host, 'GET', `/${uid}`);
  const inputUid = videoInput(video), camera = inputUid ? await readInput(host, inputUid) : null;
  if (!camera || camera.user_id !== account) return { state: 'ignored' };
  if (!video.readyToStream || video.status?.state !== 'ready') return { state: 'waiting' };
  const address = await downloadUrl(host, uid);
  if (!address) return { state: 'waiting' };
  await current(host, 'camera:file', { uid });
  const head = await stream(host, 'HEAD', address);
  let total = Number(head?.content_length ?? head?.headers?.['content-length']);
  if (!head?.ok || !Number.isFinite(total) || total <= 0) {
    const probe = await stream(host, 'GET', address, { range: 'bytes=0-0', response: 'metadata' });
    total = Number(/\/(\d+)$/.exec(probe?.content_range ?? '')?.[1]);
  }
  if (!Number.isSafeInteger(total) || total <= 0) throw fail('Stream did not say how long the recording file is.', 'no_length');
  const name = progress?.name ?? targetName(video, camera, uid);
  let send = progress?.send_bytes_to, offset = progress?.offset ?? 0;
  if (!send || progress.byte_length !== total) {
    await current(host, 'camera:file', { uid });
    const upload = await callFiles(host, 'startUpload', { name, byte_length: total, media_type: 'video/mp4', request_key: `camera-upload:${uid}:${total}` });
    send = upload?.send_bytes_to;
    if (typeof send !== 'string' || !send) throw fail('Files did not return an upload lease.', 'upload_start_refused');
    offset = 0;
  }
  const began = Date.now();
  while (offset < total) {
    await current(host, 'camera:file', { uid });
    const requestedEnd = Math.min(total - 1, offset + PART_BYTES - 1);
    const part = await stream(host, 'GET', address, { range: `bytes=${offset}-${requestedEnd}`, response: 'bytes' });
    const bytes = part?.bytes;
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw fail('Stream returned no recording bytes.', 'download_failed');
    const end = offset + bytes.byteLength;
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(part.content_range ?? '');
    if (end > requestedEnd + 1 || (part.content_range != null
      ? !range || Number(range[1]) !== offset || Number(range[2]) !== end - 1 || Number(range[3]) !== total
      : offset !== 0 || bytes.byteLength !== total))
      throw fail('Stream did not confirm the requested recording byte range; its provider copy was left untouched.', 'download_range_invalid');
    await current(host, 'camera:file', { uid });
    const ack = await callFiles(host, 'putPart', { send_bytes_to: send, offset, bytes }, `recording:${uid}:part:${offset}`);
    offset = end;
    if (offset === total && !['stored', 'present'].includes(ack?.state ?? ack)) throw fail(`Files has not confirmed the completed recording: ${ack?.state ?? ack}.`, 'not_confirmed');
    await state(host, 'put', filingKey(uid), { state: 'filing', name, byte_length: total, send_bytes_to: send, offset });
    if (offset < total && Date.now() - began > budgetMs) {
      return { state: 'more', offset, of: total };
    }
  }
  await current(host, 'camera:file', { uid });
  const stored = await callFiles(host, 'describe', { name });
  if (stored?.stored !== true || !/^1f:[a-f0-9]{64}$/.test(stored.identity ?? '') || stored.byte_length !== total)
    throw fail('Files has not confirmed the complete recording identity and length.', 'not_confirmed');
  const completed = { state: 'filed', name, identity: stored.identity, bytes: total, account, input_uid: inputUid, at: new Date().toISOString() };
  await state(host, 'put', filingKey(uid), completed);
  return finishFiling(host, account, uid, completed);
}

async function file(host, account, input) {
  if (input.uid) return fileOne(host, account, input.uid, input.budget_ms ?? 40_000);
  const limit = Math.min(100, Math.max(1, Number.isInteger(input.limit) ? input.limit : 20));
  const page = await readList(host, input.after ?? null, limit), results = [];
  for (const item of page.cameras) {
    await current(host, 'camera:file', { camera_id: item.camera_id });
    const videos = await stream(host, 'GET', `/live_inputs/${item.uid}/videos`);
    for (const video of Array.isArray(videos) ? videos : []) {
      if (!video.readyToStream || video.status?.state !== 'ready') continue;
      results.push({ video: video.uid, ...(await fileOne(host, account, video.uid, input.budget_ms ?? 40_000)) });
    }
  }
  const count = value => results.filter(item => item.state === value).length;
  return { filed: count('filed'), more: count('more'), waiting: count('waiting'), results, next: page.next };
}

// This entry is callable by a trusted signed-in browser surface only. Do not
// register reveal_key as a tool: tool results never receive ingest credentials.
async function revealKeyFor(host, account, cameraId) {
  const permission = await current(host, 'camera:reveal-key', { camera_id: cameraId, browser_only: true });
  if (permission?.browser !== true || permission?.account_id !== account) throw fail('A camera key is shown only on the owner account’s signed-in recording screen.', 'camera_key_browser_only', 403);
  const item = await state(host, 'get', cameraKey(cameraId));
  const record = item?.value ? await readInput(host, item.value.uid) : null;
  if (!record || record.user_id !== account) throw fail('That camera is not here.', 'unknown_camera', 404);
  const finalPermission = await current(host, 'camera:reveal-key', { camera_id: cameraId, browser_only: true });
  if (finalPermission?.browser !== true || finalPermission?.account_id !== account) throw fail('The owner browser permission changed.', 'camera_key_browser_only', 403);
  return { camera_id: cameraId, rtmps_url: record.rtmps_url, stream_key: record.rtmps_key, srt_url: record.srt_url };
}

export const connectCamera = (input = {}, host) => run({ ...input, operation: 'connect' }, host);
export const listCameras = (input = {}, host) => run({ ...input, operation: 'list' }, host);
export const fileCameraRecordings = (input = {}, host) => run({ ...input, operation: 'file' }, host);
export const removeCamera = (input = {}, host) => run({ ...input, operation: 'remove' }, host);
export const revealKey = async (input = {}, host) => revealKeyFor(host, await accountOf(host), input.camera_id);

const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const constantTimeEqual = (a, b) => {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
};
export async function onStreamWebhook({ body, signature } = {}, host) {
  if (typeof body !== 'string' || new TextEncoder().encode(body).byteLength > 256 * 1024) throw fail('The Stream notice is too large or missing.', 'webhook_body_invalid', 413);
  const account = await accountOf(host);
  const saved = await state(host, 'get', WEBHOOK_SECRET, undefined, { private: true, secret: true });
  const key = saved?.value ?? saved;
  const fields = Object.create(null);
  if (typeof signature !== 'string' || signature.length > 1024) throw fail('The Stream notice is not current and signed.', 'webhook_signature_invalid', 401);
  for (const part of signature.split(',')) {
    const at = part.indexOf('=');
    if (at < 1) continue;
    const name = part.slice(0, at).trim();
    if (name !== 'time' && name !== 'sig1') continue;
    if (Object.hasOwn(fields, name)) throw fail('The Stream signature repeats a field.', 'webhook_signature_invalid', 401);
    fields[name] = part.slice(at + 1).trim();
  }
  const time = Number(fields.time);
  if (typeof key !== 'string' || !key || !/^[a-f0-9]{64}$/.test(fields.sig1 ?? '') || !/^\d+$/.test(fields.time ?? '')
    || !Number.isSafeInteger(time) || Math.abs(Math.floor(Date.now() / 1000) - time) > 600)
    throw fail('The Stream notice is not current and signed.', 'webhook_signature_invalid', 401);
  const mac = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = hex(await crypto.subtle.sign('HMAC', mac, new TextEncoder().encode(`${fields.time}.${body}`)));
  if (!constantTimeEqual(expected, fields.sig1)) throw fail('The Stream notice is not signed by the connected provider.', 'webhook_signature_invalid', 401);
  let notice;
  try { notice = JSON.parse(body); } catch { throw fail('The Stream notice is not JSON.', 'webhook_json_invalid', 400); }
  const uid = notice?.uid;
  if (typeof uid !== 'string' || !UID.test(uid)) return { received: true, ignored: 'No video in this notice.' };
  // A signed notice only wakes the package. Ownership is established by reading Stream again.
  const video = await stream(host, 'GET', `/${uid}`);
  const input = videoInput(video), camera = input ? await readInput(host, input) : null;
  if (!camera || camera.user_id !== account) return { received: true, ignored: 'Not one of this account’s cameras.' };
  if (typeof host?.continuation !== 'function') throw fail('The admitted continuation capability is unavailable.', 'continuation_unavailable', 503);
  return call(host, 'continuation', { operation: 'dispatch', action: 'camera-file', account_id: account,
    resource: `camera-recording:${uid}`, input: { uid }, request_key: `stream-webhook:${uid}`,
    original_effect_policy: 'reconcile-original-command-do-not-redispatch' });
}

/** Marketplace module ABI: run(input, host), with named host capability functions. */
export async function run(input = {}, host) {
  const operation = input.operation;
  const account = await accountOf(host);
  if (operation === 'connect') return connect(host, account, input.name);
  if (operation === 'list') return list(host, input);
  if (operation === 'file') return file(host, account, input);
  if (operation === 'remove') return remove(host, account, input.camera_id);
  if (operation === 'reveal_key') return revealKeyFor(host, account, input.camera_id);
  throw fail('Choose connect, list, file or remove.', 'camera_operation_unknown', 400);
}

export const cameraPackage = Object.freeze({
  id: 'module:network-cameras',
  version: 1,
  entry: 'camera.mjs',
  capabilities: ['stream', 'state', 'files', 'current'],
  tools: ['connect_camera', 'list_cameras', 'file_camera_recordings', 'remove_camera'],
});
