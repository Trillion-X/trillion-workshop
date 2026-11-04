import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { bearerControl, namespaceClient } from '../do-work/namespace-client.mjs';

const ORIGIN = 'https://namespace.example';
const NAME = '/Company files/Video one.mp4';
const ROW = { identity: `1f:${'a'.repeat(64)}`, byte_length: 30502175672 };
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const clientFor = (control, options = {}) => namespaceClient({ origin: ORIGIN, control,
  fetchImpl: async () => { throw new Error('Metadata recovery must not fetch file bytes.'); }, ...options });
const REFERENCE = { space_id: 'membership_team', item_id: 'item_clip' };
const deadline = error => error?.name === 'TimeoutError';
const trackTimers = t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const schedule = globalThis.setTimeout, clear = globalThis.clearTimeout, pending = new Set();
  t.mock.method(globalThis, 'setTimeout', (work, delay, ...args) => {
    let timer;
    timer = schedule(() => { pending.delete(timer); work(...args); }, delay);
    pending.add(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => { pending.delete(timer); return clear(timer); });
  return pending;
};

test('metadata recovery retries the same name after a busy response without fetching bytes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const client = clientFor(async (path, options) => {
    calls.push({ path, options });
    return calls.length === 1 ? { status: 503, body: { error: 'busy' } } : { status: 200, body: ROW };
  });
  const pending = client.file(NAME);
  await flush();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(999);
  await flush();
  assert.equal(calls.length, 1, 'backoff prevents an immediate retry storm');
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, ROW);
  assert.deepEqual(calls.map(call => call.path), Array(2).fill('/namespace/files/lookup'));
  assert.ok(calls.every(call => call.options.signal instanceof AbortSignal));
  assert.equal(calls[0].options.signal, calls[1].options.signal, 'retries share the same operation deadline');
  assert.equal(getEventListeners(calls[0].options.signal, 'abort').length, 0);
});

test('mounted file metadata selects the bounded mode for names and identities and retains paced recovery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const row = { ...ROW, media_type: 'video/mp4', names: [NAME], stored: true };
  for (const selector of [NAME, ROW.identity]) {
    const calls = [];
    const client = clientFor(async (path, options) => {
      calls.push({ path, options });
      return calls.length === 1 ? { status: 503, body: { error: 'busy' } } : { status: 200, body: row };
    });
    const pending = client.file(selector, { metadataOnly: true });
    await flush(); assert.equal(calls.length, 1);
    t.mock.timers.tick(1000);
    assert.deepEqual(await pending, row);
    assert.deepEqual(calls.map(call => call.path), Array(2).fill('/namespace/files/lookup'));
    assert.deepEqual(calls.map(call => call.options.body), Array(2).fill({ ...(selector.startsWith('/') ? { name: selector } : { identity: selector }), metadata: 'file' }));
    assert.equal(calls[0].options.signal, calls[1].options.signal);
    assert.equal(getEventListeners(calls[0].options.signal, 'abort').length, 0);
  }
});

test('mounted metadata rejects legacy or malformed successes and treats current access refusal as final', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const row = { ...ROW, names: [NAME], stored: true };
  for (const body of [ROW, null, [], { ...row, error: '' }, { ...row, identity: 'invalid' },
    { ...row, byte_length: null }, { ...row, byte_length: Number.MAX_SAFE_INTEGER + 1 }, { ...row, byte_length: -1 },
    { ...row, stored: false }, { ...row, growing: 'true' }, { ...row, growing: true },
    { ...row, names: ['/Other.mp4'] }, { ...row, names: [12] }, { ...row, names: ['/bad\nname'] },
    { ...row, names: Array(21).fill(NAME) }]) {
    await assert.rejects(clientFor(async () => ({ status: 200, body })).file(NAME, { metadataOnly: true }), /current file metadata/);
  }
  for (const status of [404, 401, 403, 409, 429]) {
    let calls = 0;
    const client = clientFor(async () => { calls++; return { status, body: { error: 'refused' } }; });
    if (status === 404) assert.equal(await client.file(NAME, { metadataOnly: true }), null);
    else await assert.rejects(client.file(NAME, { metadataOnly: true }), error => {
      assert.equal(error.status, status, 'Output delivery keeps this exact response status');
      assert.match(error.message, new RegExp(`\\(${status}\\): refused`));
      return true;
    });
    t.mock.timers.tick(120000); assert.equal(calls, 1);
  }
  const arriving = { ...row, identity: 'up:' + 'b'.repeat(32), stored: false, growing: true, length_known: false };
  assert.deepEqual(await clientFor(async () => ({ status: 200, body: arriving })).file(NAME, { metadataOnly: true }), arriving);
  const defaultClient = clientFor(async path => { assert.equal(path, '/namespace/files/lookup'); return { status: 200, body: ROW }; });
  assert.deepEqual(await defaultClient.file(NAME), ROW, 'Existing downloadable metadata is unchanged');
});

test('missing metadata stays null and access or other client refusals are never retried', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const status of [404, 401, 403, 409, 429]) {
    let calls = 0;
    const client = clientFor(async () => { calls++; return { status, body: { error: 'refused' } }; });
    if (status === 404) assert.equal(await client.file(NAME), null);
    else await assert.rejects(client.file(NAME), new RegExp(`\\(${status}\\): refused`));
    t.mock.timers.tick(120000);
    assert.equal(calls, 1, `${status} is final`);
  }
});

test('metadata recovers after a dropped transport and stops after the existing eight-attempt bound', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let recoverCalls = 0;
  const recovered = clientFor(async () => {
    if (++recoverCalls === 1) throw new TypeError('connection reset');
    return { status: 200, body: ROW };
  }).file(NAME);
  await flush();
  t.mock.timers.tick(1000);
  assert.deepEqual(await recovered, ROW);
  assert.equal(recoverCalls, 2);

  let calls = 0;
  const exhausted = clientFor(async () => { calls++; return { status: 503, body: { error: 'still busy' } }; }, { namesTimeoutMs: 120000 }).file(NAME);
  const refusal = assert.rejects(exhausted, /\(503\): still busy/);
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    await flush();
    t.mock.timers.tick(delay);
  }
  await refusal;
  assert.equal(calls, 8);
  t.mock.timers.tick(120000);
  assert.equal(calls, 8, 'no scheduled continuation survives exhaustion');
});

test('canceling metadata during backoff stops the timer and makes no later lookup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController(), reason = new Error('lookup canceled');
  let calls = 0;
  const pending = clientFor(async (_path, options) => {
    calls++;
    assert.notEqual(options.signal, controller.signal);
    assert.equal(options.signal.aborted, false);
    return { status: 503, body: { error: 'busy' } };
  }).file(NAME, { signal: controller.signal });
  const refusal = assert.rejects(pending, error => error === reason);
  await flush();
  controller.abort(reason);
  await refusal;
  t.mock.timers.tick(120000);
  await flush();
  assert.equal(calls, 1);
});

test('cancellation before lookup or during its response never becomes a transient retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const before = new AbortController(), reason = new Error('canceled');
  before.abort(reason);
  let calls = 0;
  await assert.rejects(clientFor(async () => { calls++; return { status: 200, body: ROW }; })
    .file(NAME, { signal: before.signal }), error => error === reason);
  assert.equal(calls, 0);

  const during = new AbortController();
  await assert.rejects(clientFor(async () => {
    calls++;
    during.abort(reason);
    throw reason;
  }).file(NAME, { signal: during.signal }), error => error === reason);
  t.mock.timers.tick(120000);
  assert.equal(calls, 1);
});

test('lease recovery keeps its existing request shape, bounded backoff and warm reuse', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const client = clientFor(async (path, options) => {
    calls.push({ path, options });
    return calls.length === 1 ? { status: 502, body: {} }
      : { status: 200, body: { lease: 'test-capability', expires_at: new Date(Date.now() + 86400000).toISOString() } };
  });
  const pending = client.lease('read');
  await flush();
  t.mock.timers.tick(1000);
  assert.equal(await pending, 'test-capability');
  assert.equal(await client.lease('read'), 'test-capability');
  assert.deepEqual(calls.map(({ path, options: { signal, ...options } }) => ({ path, options })),
    Array(2).fill({ path: '/namespace/leases', options: { method: 'POST', body: { scope: 'read', seconds: 86400 } } }));
  assert.equal(calls[0].options.signal, calls[1].options.signal);
  assert.equal(getEventListeners(calls[0].options.signal, 'abort').length, 0);
});

// Mock time advances the operation budget, never a large real sleep. Byte checks use only tiny
// deterministic supplies; no test opens media or downloads a real file.
for (const stage of ['headers', 'body']) test(`control deadline covers stalled ${stage} for private files, shared files and leases`, async t => {
  const timers = trackTimers(t);
  for (const operation of ['file', 'fileMetadata', 'sharedFile', 'lease']) {
    let calls = 0, observed;
    const fetchImpl = async (_url, { signal }) => {
      calls++;
      observed = signal;
      // Deliberately ignore cancellation. The control owner's caller must still settle on its deadline.
      if (stage === 'headers') return new Promise(() => {});
      return { status: 200, text: () => new Promise(() => {}) };
    };
    const client = clientFor(bearerControl({ origin: ORIGIN, authorization: async () => 'test-only', fetchImpl }), { namesTimeoutMs: 50 });
    const pending = operation === 'file' ? client.file(NAME) : operation === 'fileMetadata' ? client.file(NAME, { metadataOnly: true }) : operation === 'sharedFile' ? client.sharedFile(REFERENCE) : client.lease('read');
    const refused = assert.rejects(pending, deadline);
    await flush();
    assert.equal(calls, 1);
    t.mock.timers.tick(49);
    await flush();
    assert.equal(observed.aborted, false);
    t.mock.timers.tick(1);
    await refused;
    await flush();
    assert.equal(observed.aborted, true);
    assert.equal(timers.size, 0);
    assert.equal(getEventListeners(observed, 'abort').length, 0);
    t.mock.timers.tick(120000);
    await flush();
    assert.equal(calls, 1, 'a timed-out control read never starts a later retry');
  }
});

test('shared permission and stalled spaces or exact-item catalogs share one total deadline', async t => {
  const timers = trackTimers(t);
  for (const stalled of ['/spaces', 'item']) {
    const calls = [], signals = [];
    const client = clientFor(async (path, { signal }) => {
      calls.push(path);
      signals.push(signal);
      if (path.endsWith('/file')) return new Promise(resolve => setTimeout(() => resolve({ status: 200, body: ROW }), 40));
      if (path === '/spaces') return stalled === '/spaces' ? new Promise(() => {})
        : { status: 200, body: { spaces: [{ space_id: REFERENCE.space_id, title: 'Company' }] } };
      return new Promise(() => {});
    }, { namesTimeoutMs: 50 });
    const pending = client.sharedNamespaceFile(REFERENCE, { root: '/Shared', catalog: new Map() });
    const refused = assert.rejects(pending, deadline);
    await flush();
    t.mock.timers.tick(40);
    await flush();
    assert.equal(calls.length, stalled === '/spaces' ? 2 : 3);
    assert.ok(signals.every(signal => signal === signals[0]), 'grant and catalog reads use one signal');
    t.mock.timers.tick(9);
    await flush();
    assert.equal(signals[0].aborted, false);
    t.mock.timers.tick(1);
    await refused;
    await flush();
    assert.equal(timers.size, 0);
    assert.equal(getEventListeners(signals[0], 'abort').length, 0);
  }
});

test('a stalled catalog reused inside one admission is bounded and cannot dispatch after late resolution', async t => {
  const timers = trackTimers(t), calls = [];
  let release;
  const catalog = new Map([['/spaces', new Promise(resolve => { release = resolve; })]]);
  const client = clientFor(async path => { calls.push(path); return { status: 200, body: ROW }; }, { namesTimeoutMs: 50 });
  const pending = client.sharedNamespaceFile(REFERENCE, { root: '/Shared', catalog });
  const refused = assert.rejects(pending, deadline);
  await flush();
  assert.equal(calls.length, 1, 'the /file grant is still freshly checked');
  t.mock.timers.tick(50);
  await refused;
  release({ spaces: [{ space_id: REFERENCE.space_id, title: 'Company' }] });
  await flush();
  assert.equal(calls.length, 1, 'the expired operation cannot request the item after its cached catalog settles');
  assert.equal(timers.size, 0);
});

test('a deadline during retry backoff clears both timers and prevents another attempt', async t => {
  const timers = trackTimers(t);
  let calls = 0, signal;
  const pending = clientFor(async (_path, options) => {
    calls++;
    signal = options.signal;
    return { status: 503, body: { error: 'busy' } };
  }, { namesTimeoutMs: 250 }).file(NAME);
  const refused = assert.rejects(pending, deadline);
  await flush();
  assert.equal(timers.size, 2, 'one operation timer plus its paced retry');
  t.mock.timers.tick(250);
  await refused;
  await flush();
  assert.equal(timers.size, 0);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
  t.mock.timers.tick(120000);
  await flush();
  assert.equal(calls, 1);
});

test('early caller cancellation keeps the exact reason for all bounded shared and private operations', async t => {
  const timers = trackTimers(t);
  for (const operation of ['file', 'fileMetadata', 'sharedFile', 'lease', 'sharedNamespaceFile']) {
    const controller = new AbortController(), reason = new Error(`${operation} canceled`);
    let calls = 0, signal;
    const client = clientFor(async (_path, options) => { calls++; signal = options.signal; return new Promise(() => {}); }, { namesTimeoutMs: 50 });
    const start = () => operation === 'file' ? client.file(NAME, { signal: controller.signal })
      : operation === 'fileMetadata' ? client.file(NAME, { signal: controller.signal, metadataOnly: true })
      : operation === 'sharedFile' ? client.sharedFile(REFERENCE, { signal: controller.signal })
        : operation === 'lease' ? client.lease('read', { signal: controller.signal })
          : client.sharedNamespaceFile(REFERENCE, { root: '/Shared', signal: controller.signal });
    const pending = start(), refused = assert.rejects(pending, error => error === reason);
    await flush();
    controller.abort(reason);
    await refused;
    await flush();
    assert.equal(signal.reason, reason);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(getEventListeners(signal, 'abort').length, 0);
    assert.equal(timers.size, 0);
    await assert.rejects(start(), error => error === reason);
    t.mock.timers.tick(120000);
    await flush();
    assert.equal(calls, 1, 'pre-canceled or expired work cannot dispatch');
  }
});

test('success, absence and refusal remove deadlines and caller listeners for metadata operations', async t => {
  const timers = trackTimers(t);
  for (const operation of ['file', 'missing', 'refused', 'sharedFile', 'lease', 'entry', 'names', 'sharedNamespaceFile']) {
    const controller = new AbortController(), signals = [];
    const client = clientFor(async (path, { signal }) => {
      signals.push(signal);
      if (operation === 'missing') return { status: 404, body: {} };
      if (operation === 'refused') return { status: 403, body: { error: 'not shared' } };
      if (operation === 'lease') return { status: 200, body: { lease: 'test-capability', expires_at: new Date(Date.now() + 86400000).toISOString() } };
      if (operation === 'entry') return { status: 200, body: { name: NAME, found: true, entry: { name: NAME, folder: false } } };
      if (operation === 'names') return { status: 200, body: { names: [] } };
      if (path === '/spaces') return { status: 200, body: { spaces: [{ space_id: REFERENCE.space_id, title: 'Company' }] } };
      if (path.includes('/items?')) return { status: 200, body: { space_id: REFERENCE.space_id, items: [{ item_id: REFERENCE.item_id, kind: 'file', title: 'Video one.mp4', body: { ...ROW, name: NAME } }], next_before: null } };
      return { status: 200, body: ROW };
    }, { namesTimeoutMs: 50 });
    const options = { signal: controller.signal };
    if (operation === 'refused') await assert.rejects(client.sharedFile(REFERENCE, options), /not shared/);
    else if (operation === 'sharedFile') assert.deepEqual(await client.sharedFile(REFERENCE, options), ROW);
    else if (operation === 'lease') assert.equal(await client.lease('read', options), 'test-capability');
    else if (operation === 'entry') assert.equal((await client.entry(NAME, options)).name, NAME);
    else if (operation === 'names') assert.deepEqual(await client.names('/', options), { names: [] });
    else if (operation === 'sharedNamespaceFile') assert.equal((await client.sharedNamespaceFile(REFERENCE, { ...options, root: '/Shared' })).identity, ROW.identity);
    else assert.deepEqual(await client.file(NAME, options), operation === 'missing' ? null : ROW);
    assert.equal(timers.size, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.ok(signals.every(signal => getEventListeners(signal, 'abort').length === 0));
    t.mock.timers.tick(120000);
    controller.abort(new Error('too late'));
    assert.ok(signals.every(signal => !signal.aborted), 'completed work has no surviving deadline or caller listener');
  }
});

test('metadata admission leaves the lifetime of a video byte reader unchanged', async t => {
  const timers = trackTimers(t);
  let finishBytes, byteCalls = 0;
  const client = namespaceClient({ origin: ORIGIN, namesTimeoutMs: 50,
    control: async () => ({ status: 200, body: { lease: 'test-capability', expires_at: new Date(Date.now() + 86400000).toISOString() } }),
    fetchImpl: async (_url, options) => {
      byteCalls++;
      assert.equal(options.signal, undefined);
      return new Promise(resolve => { finishBytes = resolve; });
    } });
  let finished = false;
  const bytes = client.readers()['http-client']({ url: `${ORIGIN}/namespace/bytes/${ROW.identity}` }).then(value => { finished = true; return value; });
  await flush();
  assert.equal(byteCalls, 1);
  assert.equal(timers.size, 0);
  t.mock.timers.tick(120000);
  await flush();
  assert.equal(finished, false, 'metadata timeout never aborts a video read');
  finishBytes({ status: 206, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer });
  assert.deepEqual(await bytes, new Uint8Array([1, 2, 3, 4]));
});

test('the control budget rejects nonfinite, nonpositive or unrepresentable time limits', () => {
  for (const namesTimeoutMs of [0, -1, Infinity, NaN, 1.5, 2 ** 31])
    assert.throws(() => clientFor(async () => ({ status: 200, body: ROW }), { namesTimeoutMs }), /finite positive time limit/);
});

const LEASE = () => ({ status: 200, body: { lease: 'test-capability', expires_at: new Date(Date.now() + 86400000).toISOString() } });
const byteOperation = (client, operation, signal) => operation === 'reader'
  ? client.readers()['http-client']({ url: `${ORIGIN}/namespace/bytes/${ROW.identity}`, signal })
  : operation === 'readUrl' ? client.readUrl(ROW.identity, { signal })
    : operation === 'grow' ? client.grow('upload/chunks/0', { method: 'PUT', body: new Uint8Array([1]), signal })
      : client.keepWholeFiles(new Uint8Array([1]), { signal });

test('byte operations canceled before or during lease admission never dispatch bytes or retry', async t => {
  const timers = trackTimers(t);
  for (const operation of ['reader', 'readUrl', 'grow', 'keepWholeFiles']) {
    const controller = new AbortController(), reason = new Error(`${operation} canceled during admission`);
    let controlCalls = 0, byteCalls = 0, release, leaseSignal;
    const client = clientFor(async (_path, { signal }) => {
      controlCalls++; leaseSignal = signal;
      return new Promise(resolve => { release = resolve; });
    }, { namesTimeoutMs: 50, fetchImpl: async () => { byteCalls++; return new Response(new Uint8Array([1])); } });
    const pending = byteOperation(client, operation, controller.signal);
    const refused = assert.rejects(pending, error => error === reason);
    await flush();
    assert.equal(controlCalls, 1);
    controller.abort(reason);
    await refused;
    assert.equal(leaseSignal.reason, reason);
    release(LEASE());
    await flush();
    await assert.rejects(byteOperation(client, operation, controller.signal), error => error === reason);
    t.mock.timers.tick(120000);
    await flush();
    assert.equal(controlCalls, 1, 'late or pre-canceled admission cannot mint again');
    assert.equal(byteCalls, 0, 'late lease resolution cannot start a byte request');
    assert.equal(timers.size, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(getEventListeners(leaseSignal, 'abort').length, 0);
  }
});

test('cached read and write leases cannot dispatch or return a URL after caller cancellation', async t => {
  const timers = trackTimers(t);
  for (const operation of ['reader', 'readUrl', 'grow', 'keepWholeFiles']) {
    const controller = new AbortController(), reason = new Error(`${operation} canceled at cached admission`);
    let controlCalls = 0, byteCalls = 0;
    const client = clientFor(async () => { controlCalls++; return LEASE(); }, {
      fetchImpl: async () => { byteCalls++; return new Response(new Uint8Array([1])); },
    });
    await client.lease(operation === 'grow' || operation === 'keepWholeFiles' ? 'write' : 'read');
    const pending = byteOperation(client, operation, controller.signal);
    controller.abort(reason); // The cached async lease yields before the byte helper resumes.
    await assert.rejects(pending, error => error === reason);
    await flush();
    assert.equal(controlCalls, 1, 'the already-held capability is reused');
    assert.equal(byteCalls, 0, 'an aborted caller cannot dispatch using it');
    assert.equal(timers.size, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

test('canceling an ignored byte fetch settles promptly and retires its late actual body', async t => {
  const timers = trackTimers(t), controller = new AbortController(), reason = new Error('byte headers canceled');
  let release, byteCalls = 0, canceled = 0, cancellationReason, reads = 0;
  const client = clientFor(async () => LEASE(), { fetchImpl: async (_url, options) => {
    byteCalls++;
    assert.equal(options.signal, controller.signal);
    return new Promise(resolve => { release = resolve; });
  } });
  const pending = byteOperation(client, 'reader', controller.signal);
  const refused = assert.rejects(pending, error => error === reason);
  await flush();
  assert.equal(byteCalls, 1);
  assert.equal(timers.size, 0, 'lease deadline ends before byte transport');
  controller.abort(reason);
  await refused;
  release(new Response(new ReadableStream({
    pull() { reads++; }, cancel(value) { canceled++; cancellationReason = value; },
  }, { highWaterMark: 0 })));
  await flush();
  assert.equal(canceled, 1);
  assert.equal(cancellationReason, reason);
  assert.equal(reads, 0, 'a late body is retired without reading it');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  t.mock.timers.tick(120000);
  assert.equal(byteCalls, 1);
});

test('canceling a pending byte body cancels its actual source with the same reason', async t => {
  const timers = trackTimers(t), controller = new AbortController(), reason = new Error('byte body canceled');
  let byteCalls = 0, reads = 0, canceled = 0, cancellationReason;
  const source = new ReadableStream({
    pull() { reads++; }, cancel(value) { canceled++; cancellationReason = value; },
  }, { highWaterMark: 0 });
  const client = clientFor(async () => LEASE(), { namesTimeoutMs: 50, fetchImpl: async () => {
    byteCalls++; return new Response(source, { status: 206 });
  } });
  const pending = byteOperation(client, 'reader', controller.signal);
  const refused = assert.rejects(pending, error => error === reason);
  await flush();
  assert.equal(reads, 1);
  assert.equal(timers.size, 0);
  t.mock.timers.tick(120000);
  await flush();
  assert.equal(controller.signal.aborted, false, 'metadata lifetime does not cancel a signaled byte body either');
  assert.equal(canceled, 0);
  controller.abort(reason);
  await refused;
  await flush();
  assert.equal(byteCalls, 1);
  assert.equal(canceled, 1);
  assert.equal(cancellationReason, reason);
  assert.equal(source.locked, false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('refused leases retain their exact status without byte dispatch or later retry', async t => {
  const timers = trackTimers(t);
  for (const status of [401, 403, 429]) for (const operation of ['reader', 'readUrl', 'grow', 'keepWholeFiles']) {
    const controller = new AbortController();
    let controlCalls = 0, byteCalls = 0, leaseSignal;
    const client = clientFor(async (_path, { signal }) => {
      controlCalls++; leaseSignal = signal; return { status, body: { error: 'refused' } };
    }, { fetchImpl: async () => { byteCalls++; return new Response(); } });
    await assert.rejects(byteOperation(client, operation, controller.signal), error => {
      assert.equal(error.status, status);
      assert.match(error.message, new RegExp(`\\(${status}\\): refused`));
      return true;
    });
    t.mock.timers.tick(120000);
    await flush();
    assert.equal(controlCalls, 1);
    assert.equal(byteCalls, 0);
    assert.equal(timers.size, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(getEventListeners(leaseSignal, 'abort').length, 0);
  }
});

test('refused byte responses retain exact status and retire the unread diagnostic body', async t => {
  const timers = trackTimers(t);
  for (const status of [403, 416, 429, 503]) {
    const controller = new AbortController();
    let byteCalls = 0, canceled = 0, reads = 0;
    const client = clientFor(async () => LEASE(), { fetchImpl: async () => {
      byteCalls++;
      return new Response(new ReadableStream({ pull() { reads++; }, cancel() { canceled++; } },
        { highWaterMark: 0 }), { status });
    } });
    await assert.rejects(byteOperation(client, 'reader', controller.signal), error => {
      assert.equal(error.status, status);
      return true;
    });
    await flush();
    t.mock.timers.tick(120000);
    assert.equal(byteCalls, 1, 'byte refusals are not metadata retries');
    assert.equal(reads, 0);
    assert.equal(canceled, 1);
    assert.equal(timers.size, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

test('completed signaled byte readers remove listeners and leave metadata timers retired', async t => {
  const timers = trackTimers(t), controller = new AbortController();
  let byteCalls = 0;
  const client = clientFor(async () => LEASE(), { fetchImpl: async () => {
    byteCalls++; return new Response(new Uint8Array([1, 2, 3, 4]), { status: 206 });
  } });
  assert.deepEqual(await byteOperation(client, 'reader', controller.signal), new Uint8Array([1, 2, 3, 4]));
  await flush();
  assert.equal(timers.size, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  controller.abort(new Error('completed reader'));
  t.mock.timers.tick(120000);
  assert.equal(byteCalls, 1);
});
