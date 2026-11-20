// tools/notice-when-something-shows-up: the WhatsApp linked-device waiter tells each message once, as WhatsApp pushes it.
//
// The socket is the WhatsApp connection's own (bring-in-new-items-from-this-computer/computer/connections/whatsapp.mjs), here
// over a fake Baileys module, so these tests cover the one socket owner and its observe hook, not a copy. Numbers are the
// reserved fiction ranges (555-01xx).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CARRIED_BYTES, afterOf, changesOf, contentOf, describeMechanism, linkChange, partsOf, proxyAgent, readSettings, watchForTransitions,
} from '../do-work/mechanisms/whatsapp-linked-device.mjs';

const ME = '15555550100@s.whatsapp.net';
const FRIEND = '15555550101@s.whatsapp.net';
// WhatsApp's server name for groups; a group id is its creator's number (the 555-01xx fiction range) and a time.
const GROUP_SERVER = 'g.us';
const GROUP = `15555550199-1795100000@${GROUP_SERVER}`;
const AT = 1_795_100_000; // 2026-11-19 12:13:20 UTC
const iso = seconds => new Date(seconds * 1000).toISOString();
const own = readSettings({ where: 'whatsapp-of-the-person', history_since: '2026-11-19T06:00:00Z' });
const context = (extra = {}) => ({ own, account: ME, since: own.history_since, names: new Map(), now: () => AT * 1000, ...extra });
const text = (id, words, extra = {}) => ({ key: { id, remoteJid: FRIEND, fromMe: false }, messageTimestamp: AT, pushName: 'Friend', message: { conversation: words }, ...extra });
const upsert = (messages, type = 'notify') => ['messages.upsert', { messages, type }];

test('the leaf declares its identity and the eight fields of a change fact', () => {
  assert.deepEqual(describeMechanism().detail_fields, ['where', 'place', 'change', 'at', 'key', 'by', 'after', 'kinds']);
  assert.equal(readSettings({}).where, 'whatsapp');
  assert.deepEqual(readSettings({}).kinds, ['seed']);
  assert.equal(readSettings({ history_since: 'not a time' }).history_since, null);
  assert.equal(readSettings({ phone: '+1 (555) 555-0100' }).phone, '15555550100');
});

test('a text from a friend is one added message fact carrying its words, sender and time', () => {
  const [change] = changesOf(...upsert([text('A1', 'can you share the footage you have of me?')]), context());
  assert.equal(change.event_key, `${FRIEND}/A1:added`);
  assert.equal(change.detail.where, 'whatsapp-of-the-person');
  assert.equal(change.detail.place, 'message');
  assert.equal(change.detail.change, 'added');
  assert.equal(change.detail.at, iso(AT));
  assert.equal(change.detail.key, `${FRIEND}/A1`);
  assert.equal(change.detail.by, FRIEND);
  assert.deepEqual(JSON.parse(change.detail.kinds), ['seed']);
  assert.deepEqual(JSON.parse(change.detail.after), { chat: FRIEND, chat_name: 'Friend', group: false, from: FRIEND, words: 'can you share the footage you have of me?', media: [], reply_to: null });
  for (const value of Object.values(change.detail)) assert.ok(value === null || Buffer.byteLength(value) <= 1024);
});

test('a voice note is told with its kind, length and WhatsApp identity, never its bytes', () => {
  const note = { key: { id: 'V1', remoteJid: FRIEND }, messageTimestamp: AT, message: { audioMessage: { ptt: true, seconds: 14, mimetype: 'audio/ogg; codecs=opus', fileSha256: Buffer.from('voice-bytes'), fileLength: 22_000 } } };
  const after = JSON.parse(changesOf(...upsert([note]), context())[0].detail.after);
  assert.equal(after.words, null);
  assert.deepEqual(after.media, [{ kind: 'voice_note', identity: Buffer.from('voice-bytes').toString('base64'), seconds: 14, media_type: 'audio/ogg; codecs=opus', bytes: 22_000 }]);
});

test('a photo with no caption is still a message: its media is the content', () => {
  const photo = { key: { id: 'P1', remoteJid: FRIEND }, messageTimestamp: AT, message: { imageMessage: { mimetype: 'image/jpeg', fileSha256: 'cGhvdG8=' } } };
  const after = JSON.parse(changesOf(...upsert([photo]), context())[0].detail.after);
  assert.equal(after.words, null);
  assert.deepEqual(after.media, [{ kind: 'photo', identity: 'cGhvdG8=', media_type: 'image/jpeg' }]);
  const viewOnce = { ...photo, key: { id: 'P2', remoteJid: FRIEND }, message: { viewOnceMessageV2: { message: { imageMessage: { caption: 'look', fileSha256: 'eA==' } } } } };
  assert.equal(JSON.parse(changesOf(...upsert([viewOnce]), context())[0].detail.after).words, 'look');
});

test('an edit is a changed fact under the same key, and a delete a removed one', () => {
  const edit = ['messages.update', [{ key: { id: 'A1', remoteJid: FRIEND }, update: { message: { editedMessage: { message: { conversation: 'can you share both clips?' } } }, messageTimestamp: AT + 60 } }]];
  const [changed] = changesOf(...edit, context());
  assert.equal(changed.detail.change, 'changed');
  assert.equal(changed.detail.key, `${FRIEND}/A1`);
  assert.equal(changed.detail.at, iso(AT + 60));
  assert.equal(JSON.parse(changed.detail.after).words, 'can you share both clips?');
  assert.match(changed.event_key, new RegExp(`^${FRIEND}/A1:changed:[0-9a-f]{16}$`));
  const again = changesOf('messages.update', [{ key: { id: 'A1', remoteJid: FRIEND }, update: { message: { editedMessage: { message: { conversation: 'a second edit' } } } } }], context());
  assert.notEqual(again[0].event_key, changed.event_key, 'a second edit is a second fact');
  const [removed] = changesOf('messages.update', [{ key: { id: 'A1', remoteJid: FRIEND }, update: { message: null, messageStubType: 1 } }], context());
  assert.deepEqual({ change: removed.detail.change, key: removed.detail.key, event_key: removed.event_key }, { change: 'removed', key: `${FRIEND}/A1`, event_key: `${FRIEND}/A1:removed` });
  assert.deepEqual(changesOf('messages.update', [{ key: { id: 'A1', remoteJid: FRIEND }, update: { status: 4 } }], context()), [], 'a read receipt is no change');
  assert.deepEqual(changesOf(...upsert([{ key: { id: 'X', remoteJid: FRIEND }, messageTimestamp: AT, message: { protocolMessage: { type: 14 } } }]), context()), [], 'the protocol message that carries an edit is not a message');
});

test('a group message names the group and its sender', () => {
  const said = { key: { id: 'G1', remoteJid: GROUP, participant: FRIEND }, messageTimestamp: AT, pushName: 'Friend', message: { extendedTextMessage: { text: 'Thursday 7pm with both of us?', contextInfo: { stanzaId: 'G0' } } } };
  const [change] = changesOf(...upsert([said]), context({ names: new Map([[GROUP, 'Tennis crew']]) }));
  assert.equal(change.detail.by, FRIEND);
  assert.deepEqual(JSON.parse(change.detail.after), { chat: GROUP, chat_name: 'Tennis crew', group: true, from: FRIEND, words: 'Thursday 7pm with both of us?', media: [], reply_to: `${GROUP}/G0` });
});

test('a message over 1,024 bytes is cut to fit and says how long it was', () => {
  const long = 'é'.repeat(2_000);
  const [change] = changesOf(...upsert([text('L1', long)]), context());
  assert.ok(Buffer.byteLength(change.detail.after) <= CARRIED_BYTES);
  const after = JSON.parse(change.detail.after);
  assert.equal(after.from, FRIEND, 'the sender stays when the words are cut');
  assert.equal(after.words_cut, Buffer.byteLength(long));
  assert.ok(long.startsWith(after.words) && after.words.length > 300);
  const many = afterOf({ chat: FRIEND, group: false, words: null, reply_to: null, media: Array.from({ length: 40 }, (_, index) => ({ kind: 'photo', identity: `${index}`.padStart(44, 'x') })) });
  assert.ok(Buffer.byteLength(many) <= CARRIED_BYTES);
  assert.ok(JSON.parse(many).media_cut > 0);
});

test('own sends, status posts and reactions are not told unless asked', () => {
  const mine = text('M1', 'on my way', { key: { id: 'M1', remoteJid: FRIEND, fromMe: true } });
  assert.deepEqual(changesOf(...upsert([mine]), context()), []);
  assert.equal(changesOf(...upsert([mine]), context({ own: { ...own, include_own: true } }))[0].detail.by, ME);
  assert.deepEqual(changesOf(...upsert([text('S1', 'story', { key: { id: 'S1', remoteJid: 'status@broadcast' } })]), context()), []);
  assert.equal(partsOf(contentOf({ reactionMessage: { text: '👍' } })), null);
});

test('history is told only from history_since on, each with its own time', () => {
  const before = text('H0', 'last night', { messageTimestamp: Date.parse('2026-11-19T05:59:59Z') / 1000 });
  const after = text('H1', 'this morning', { messageTimestamp: Date.parse('2026-11-19T17:15:00Z') / 1000 });
  const told = changesOf('messaging-history.set', { messages: [before, after] }, context());
  assert.deepEqual(told.map(change => change.detail.key), [`${FRIEND}/H1`]);
  assert.equal(told[0].detail.at, '2026-11-19T17:15:00.000Z');
  assert.deepEqual(changesOf(...upsert([after], 'append'), context()).map(change => change.event_key), [`${FRIEND}/H1:added`]);
  assert.deepEqual(changesOf('messaging-history.set', { messages: [after] }, context({ since: null })), [], 'no history without a boundary');
});

test('pairing codes and linking are told at place link', () => {
  const step = linkChange(own, { state: 'pairing_required', code: 'ABCD1234', expires_after_seconds: 60 }, '2026-11-19T22:00:00.000Z');
  assert.equal(step.detail.place, 'link');
  assert.deepEqual(JSON.parse(step.detail.kinds), ['whatsapp-link-code']);
  assert.equal(JSON.parse(step.detail.after).code, 'ABCD1234');
  assert.equal(linkChange(own, { state: 'connected', account: '15555550100' }, 'x').detail.change, 'changed');
  assert.equal(linkChange(own, { state: 'logged_out' }, 'x').detail.change, 'removed');
});

// A fake Baileys module the real connection opens: every handler the connection registers is kept, so a test can push events.
function fakeBaileys({ registered = true, code = 'ABCD1234' } = {}) {
  const sockets = [];
  return {
    sockets,
    module: {
      fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0] }),
      useMultiFileAuthState: async () => ({ state: { creds: { registered } }, saveCreds() {} }),
      default(options) {
        const handlers = new Map();
        const socket = {
          options, user: { id: ME }, authState: { creds: { registered } },
          ev: { on: (name, handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]) },
          emit: (name, data) => (handlers.get(name) ?? []).forEach(handler => handler(data)),
          requestPairingCode: async () => code,
          groupMetadata: async jid => ({ subject: jid === GROUP ? 'Tennis crew' : null }),
          end() {},
        };
        sockets.push(socket);
        return socket;
      },
    },
  };
}

const turn = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(check, what) {
  for (let tries = 0; tries < 400; tries += 1) { if (check()) return; await turn(); }
  assert.fail(`timed out waiting for ${what}`);
}

function waiter(t, { registered = true, settings = {}, refuse = () => false, state = null } = {}) {
  const folder = mkdtempSync(path.join(tmpdir(), 'whatsapp-waiter-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  if (registered) { mkdirSync(path.join(folder, 'session')); writeFileSync(path.join(folder, 'session', 'creds.json'), JSON.stringify({ registered: true })); }
  const baileys = fakeBaileys({ registered });
  const facts = [];
  const kept = [];
  const controller = new AbortController();
  const done = watchForTransitions({ where: 'whatsapp-of-the-person', history_since: '2026-11-19T06:00:00Z', ...settings }, {
    signal: controller.signal, folder, state, proxy: null, look_ms: 5, load: async () => baileys.module, now: () => AT * 1000,
    keepState: async value => kept.push(value),
    onTransition: async transition => { if (refuse(transition)) return false; facts.push(transition); return true; },
  });
  t.after(async () => { controller.abort(); await done; });
  const socket = () => baileys.sockets.at(-1);
  return { facts, kept, baileys, socket, controller, done, open: () => socket().emit('connection.update', { connection: 'open' }) };
}

test('through the real connection: a linked session opens and each live message is told once, the same message again is not', async t => {
  const w = waiter(t);
  await until(() => w.socket(), 'the socket');
  w.open();
  await until(() => w.kept.length, 'the first link time kept');
  w.socket().emit('messages.upsert', { messages: [text('A1', 'can you share the footage?')], type: 'notify' });
  w.socket().emit('messages.upsert', { messages: [{ key: { id: 'G1', remoteJid: GROUP, participant: FRIEND }, messageTimestamp: AT, message: { conversation: 'Thursday?' } }], type: 'notify' });
  await until(() => w.facts.length === 2, 'two facts');
  assert.equal(JSON.parse(w.facts[1].detail.after).chat_name, 'Tennis crew', 'a group is named by its own metadata');
  w.socket().emit('messages.upsert', { messages: [text('A1', 'can you share the footage?')], type: 'notify' });
  w.socket().emit('messages.update', [{ key: { id: 'A1', remoteJid: FRIEND }, update: { message: null, messageStubType: 1 } }]);
  await until(() => w.facts.length === 3, 'the delete');
  assert.deepEqual(w.facts.map(fact => fact.detail.change), ['added', 'added', 'removed']);
  assert.deepEqual(w.facts.at(-1).state.told, [`${FRIEND}/A1:added`, `${GROUP}/G1:added`, `${FRIEND}/A1:removed`], 'each fact carries the keys told so far');
});

test('through the real connection: history from the boundary is told once, and its later live copy is not told again', async t => {
  const w = waiter(t);
  await until(() => w.socket(), 'the socket');
  w.open();
  const before = text('H0', 'yesterday', { messageTimestamp: Date.parse('2026-11-19T05:00:00Z') / 1000 });
  const after = text('H1', 'a friend at 11:15', { messageTimestamp: Date.parse('2026-11-19T17:15:00Z') / 1000 });
  w.socket().emit('messaging-history.set', { messages: [before, after], chats: [], contacts: [{ id: FRIEND, notify: 'Friend' }] });
  await until(() => w.facts.length === 1, 'the history fact');
  assert.equal(w.facts[0].detail.key, `${FRIEND}/H1`);
  assert.equal(w.facts[0].detail.at, '2026-11-19T17:15:00.000Z');
  w.socket().emit('messages.upsert', { messages: [after], type: 'notify' });
  await turn(); await turn();
  assert.equal(w.facts.length, 1, 'the live copy is the same fact');
});

test('a restart does not tell again what the kept state says was told, and a refused fact is not kept as told', async t => {
  const message = text('R1', 'told before the restart');
  const w = waiter(t, { state: { told: [`${FRIEND}/R1:added`], linked_at: '2026-11-19T07:00:00.000Z' }, refuse: transition => transition.detail.key.endsWith('/R2') });
  await until(() => w.socket(), 'the socket');
  w.open();
  w.socket().emit('messages.upsert', { messages: [message, text('R2', 'refused'), text('R3', 'new')], type: 'notify' });
  await until(() => w.facts.length === 1, 'the new fact');
  assert.equal(w.facts[0].detail.key, `${FRIEND}/R3`);
  assert.deepEqual(w.facts[0].state.told, [`${FRIEND}/R1:added`, `${FRIEND}/R3:added`]);
});

test('not linked: each pairing window tells its code, and linking is told when the person enters it', async t => {
  const w = waiter(t, { registered: false, settings: { phone: '+1 555 555 0100' } });
  await until(() => w.socket(), 'the socket');
  w.socket().emit('connection.update', { qr: 'qr-data' });
  await until(() => w.facts.length === 1, 'the code');
  assert.equal(w.facts[0].detail.place, 'link');
  assert.equal(JSON.parse(w.facts[0].detail.after).code, 'ABCD1234');
  w.open();
  await until(() => w.facts.length === 2, 'the link');
  assert.equal(JSON.parse(w.facts[1].detail.after).state, 'connected');
});

test('a waiter with no folder, or not linked with no phone, cannot wait and says why', async () => {
  await assert.rejects(watchForTransitions({}, { onTransition: async () => true }), /folder of its own/);
  const folder = mkdtempSync(path.join(tmpdir(), 'whatsapp-waiter-'));
  try {
    await assert.rejects(watchForTransitions({}, { folder, proxy: null, look_ms: 5, load: async () => fakeBaileys({ registered: false }).module, onTransition: async () => true }), /names no phone/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('the proxy agent opens each connection as a CONNECT tunnel to the named host', async t => {
  const asked = [];
  const target = net.createServer(socket => socket.end('hello'));
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  const proxy = http.createServer();
  proxy.on('connect', (request, client) => {
    asked.push(request.url);
    const upstream = net.connect(target.address().port, '127.0.0.1', () => { client.write('HTTP/1.1 200 Connection established\r\n\r\n'); upstream.pipe(client); client.pipe(upstream); });
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => { proxy.close(); target.close(); });
  const agent = proxyAgent(`http://127.0.0.1:${proxy.address().port}`, { connect: ({ socket }) => socket });
  const socket = await new Promise((resolve, reject) => agent.createConnection({ host: 'web.whatsapp.com', port: 443 }, (error, made) => (error ? reject(error) : resolve(made))));
  const said = await new Promise(resolve => { let all = ''; socket.on('data', chunk => { all += chunk; }); socket.on('end', () => resolve(all)); });
  assert.deepEqual(asked, ['web.whatsapp.com:443']);
  assert.equal(said, 'hello');
});

test('the sender rides in after as from, for a group participant, a friend and a delete', () => {
  const said = { key: { id: 'G2', remoteJid: GROUP, participant: FRIEND }, messageTimestamp: AT, message: { conversation: 'see you' } };
  assert.equal(JSON.parse(changesOf(...upsert([said]), context())[0].detail.after).from, FRIEND);
  assert.equal(JSON.parse(changesOf(...upsert([text('F1', 'hi')]), context())[0].detail.after).from, FRIEND);
  const [removed] = changesOf('messages.update', [{ key: { id: 'F1', remoteJid: FRIEND }, update: { message: null, messageStubType: 1 } }], context());
  assert.equal(JSON.parse(removed.detail.after).from, FRIEND);
});

test('linked is told once when the socket opens after WhatsApp restarts it (515), even after the code ran out', async t => {
  let clock = AT * 1000;
  const folder = mkdtempSync(path.join(tmpdir(), 'whatsapp-waiter-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const baileys = fakeBaileys({ registered: false });
  const facts = [];
  const controller = new AbortController();
  const done = watchForTransitions({ where: 'whatsapp-of-the-person', phone: '15555550100' }, {
    signal: controller.signal, folder, proxy: null, look_ms: 5, load: async () => baileys.module, now: () => clock,
    keepState: async () => {}, onTransition: async transition => { facts.push(transition); return true; },
  });
  t.after(async () => { controller.abort(); await done; });
  await until(() => baileys.sockets.length, 'the socket');
  baileys.sockets[0].emit('connection.update', { qr: 'qr-data' });
  await until(() => facts.length === 1, 'the code');
  // The person enters the code: WhatsApp registers the session and restarts the socket (515) after the code's window.
  mkdirSync(path.join(folder, 'session'), { recursive: true });
  writeFileSync(path.join(folder, 'session', 'creds.json'), JSON.stringify({ registered: true }));
  clock += 61_000;
  baileys.sockets[0].emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
  await until(() => baileys.sockets.length === 2, 'the reconnect');
  baileys.sockets[1].emit('connection.update', { connection: 'open' });
  await until(() => facts.some(fact => fact.detail.place === 'link' && fact.detail.change === 'changed'), 'linked');
  await turn(); await turn(); await turn();
  assert.equal(facts.filter(fact => fact.detail.place === 'link' && fact.detail.change === 'changed').length, 1, 'linked once');
  assert.equal(facts.filter(fact => fact.detail.change === 'added' && fact.detail.place === 'link').length, 1, 'no second code was asked for');
  assert.equal(JSON.parse(facts.at(-1).detail.after).state, 'connected');
});
