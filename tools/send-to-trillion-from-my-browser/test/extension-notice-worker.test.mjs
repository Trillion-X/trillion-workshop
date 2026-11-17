import assert from 'node:assert/strict';
import test from 'node:test';

const local = new Map([['tokens', { access_token: 'browser-token', refresh_token: 'refresh', expires_at: Date.now() + 3_600_000 }]]);
const session = new Map();
const registered = [];
const shown = [];
const opened = [];
const toolCalls = [];
const callbacks = {};
let failReadOnce = true;
let cursor = 0;

Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
  userAgentData: { brands: [{ brand: 'Google Chrome' }] }, locks: { request: async (_name, operation) => operation() },
} });
globalThis.chrome = {
  runtime: { getURL: name => `chrome-extension://browser/${name}`, getManifest: () => ({ version: '1.3.4' }),
    onStartup: { addListener: fn => { callbacks.start = fn; } }, onInstalled: { addListener: fn => { callbacks.install = fn; } },
    onMessage: { addListener: fn => { callbacks.message = fn; } } },
  storage: {
    local: {
      get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => local.has(key)).map(key => [key, local.get(key)])),
      set: async values => { for (const [key, value] of Object.entries(values)) local.set(key, value); },
      remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) local.delete(key); },
    },
    session: {
      get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => session.has(key)).map(key => [key, session.get(key)])),
      set: async values => { for (const [key, value] of Object.entries(values)) session.set(key, value); },
      remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) session.delete(key); },
    },
    onChanged: { addListener: fn => { callbacks.storage = fn; } },
  },
  alarms: { create: async () => {}, onAlarm: { addListener: fn => { callbacks.alarm = fn; } } },
  notifications: {
    create: async (id, options) => { shown.push({ id, options }); }, clear: async id => { shown.push({ clear: id }); },
    onButtonClicked: { addListener: fn => { callbacks.button = fn; } }, onClicked: { addListener: fn => { callbacks.click = fn; } },
    onClosed: { addListener: fn => { callbacks.closed = fn; } },
  },
  tabs: { query: async () => [], create: async options => { opened.push(options); return { id: 77 }; }, update: async () => {} },
  windows: { update: async () => {}, create: async () => {} },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
};
globalThis.self = { registration: { pushManager: {
  getSubscription: async () => null,
  subscribe: async options => ({ options, unsubscribe: async () => true, toJSON: () => ({ endpoint: 'https://push.example/subscription', keys: { p256dh: 'p', auth: 'a' } }) }),
} }, addEventListener: (name, fn) => { callbacks[name] = fn; } };
globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  if (!target.endsWith('/mcp')) return Response.json({});
  const body = JSON.parse(init.body);
  if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: { _meta: { 'ai.gettrillion/account': { account_id: 'account-a' } } } });
  assert.equal(body.params.name, 'run_resource_operation');
  const operation = body.params.arguments;
  assert.equal(operation.address, '@tools');
  assert.equal(operation.method, 'tools:run');
  assert.ok(operation.request_key);
  const call = { tool_id: operation.input.tool, input: operation.input.input, request_key: operation.request_key };
  toolCalls.push(call);
  let result = {};
  if (call.tool_id === 'tool:my-browser-push-application-key') result = { applicationServerKey: 'AQID' };
  else if (call.tool_id === 'tool:register-my-notification-device') {
    registered.push(call.input); result = { device_id: 'device-a', changed: true, devices: [] };
  } else if (call.tool_id === 'tool:my-device-notices') {
    result = { device_id: 'device-a', channel: 'web-push', cursor, notices: cursor === 0 ? [{
      id: 'told:41', title: 'Ready', body: 'The result is ready.', open: '/files/result', read: false,
      actions: [{ id: 'tool:open-result', label: 'Open result' }], level: 'active',
    }] : [] };
    cursor = 41;
  } else if (call.tool_id === 'tool:act-on-my-notice') result = { done: true, said: 'Opened it.', open: '/files/result' };
  else if (call.tool_id === 'tool:mark-my-notices-read') {
    if (failReadOnce) { failReadOnce = false; return Response.json({ jsonrpc: '2.0', id: body.id, result: { isError: true, content: [{ type: 'text', text: 'The account is busy.' }] } }); }
    result = { changed: 1 };
  }
  return Response.json({ jsonrpc: '2.0', id: body.id, result: { structuredContent: {
    exit_code: 0, replayed: false, result: { ...result, said: 'Workshop completed the action.' }, tool: call.tool_id,
  } } });
};

const { registerThisBrowser, refreshUnread, act } = await import('../src/notice-worker.mjs');

test('the running worker registers, recovers and acts on a browser-scoped notice without crossing accounts', async () => {
  const device = await registerThisBrowser();
  assert.ok(device, JSON.stringify({ toolCalls, local: [...local] }));
  assert.equal(device.device_id, 'device-a');
  assert.deepEqual(registered, [{ route: 'web-push', label: 'Chrome', address: {
    endpoint: 'https://push.example/subscription', keys: { p256dh: 'p', auth: 'a' },
  } }]);
  assert.deepEqual(local.get('browser-notification-device'), { account: 'account-a', device_id: 'device-a' });

  await refreshUnread();
  const list = toolCalls.find(call => call.tool_id === 'tool:my-device-notices');
  assert.deepEqual(list.input, { device_id: 'device-a', channel: 'web-push', after: 0, limit: 100 });
  const notice = shown.find(row => row.options?.title === 'Ready');
  assert.ok(notice?.id.includes('account-a'));

  await assert.rejects(act(notice.id, 'tool:open-result'), /The account is busy/);
  const firstAction = toolCalls.find(call => call.tool_id === 'tool:act-on-my-notice');
  const pending = session.get('notice-action:account-a:told:41:tool:open-result');
  assert.equal(firstAction.input.id, 'told:41');
  assert.equal(firstAction.input.action, 'tool:open-result');
  assert.equal(firstAction.input.submission_id, pending.submissionId);
  assert.equal(firstAction.request_key, pending.submissionId);

  await act(notice.id, 'tool:open-result');
  const actions = toolCalls.filter(call => call.tool_id === 'tool:act-on-my-notice');
  assert.equal(actions.length, 2);
  assert.equal(actions[0].request_key, actions[1].request_key, 'the same action retry uses the same idempotency key');
  const read = toolCalls.find(call => call.tool_id === 'tool:mark-my-notices-read');
  assert.deepEqual(read.input, { ids: ['told:41'], read: true, on: { channel: 'browser', device_id: 'device-a' } });
  assert.ok(opened.some(tab => tab.url === 'https://app.gettrillion.ai/files/result'));
});

test('a Web Push action message submits the exact notice and action IDs', async () => {
  let work;
  callbacks.push({
    data: { json: () => ({ type: 'notice-action', notice_id: 'told:push-82', action: 'tool:accept-exact' }) },
    waitUntil: promise => { work = promise; },
  });
  await work;
  const call = toolCalls.filter(row => row.tool_id === 'tool:act-on-my-notice').at(-1);
  assert.equal(call.input.id, 'told:push-82');
  assert.equal(call.input.action, 'tool:accept-exact');
  assert.equal(call.input.submission_id, call.request_key);
  const read = toolCalls.filter(row => row.tool_id === 'tool:mark-my-notices-read').at(-1);
  assert.deepEqual(read.input, { ids: ['told:push-82'], read: true, on: { channel: 'browser', device_id: 'device-a' } });
});

test('the worker accepts the sender service worker message contract', async () => {
  let response;
  const keepOpen = callbacks.message({ type: 'notice-action', notice_id: 'told:message-93', action: 'tool:exact-message-action' }, {}, value => { response = value; });
  assert.equal(keepOpen, true);
  await new Promise(resolve => setImmediate(resolve));
  const call = toolCalls.filter(row => row.tool_id === 'tool:act-on-my-notice').at(-1);
  assert.equal(call.input.id, 'told:message-93');
  assert.equal(call.input.action, 'tool:exact-message-action');
  assert.equal(response.done, true);
});
