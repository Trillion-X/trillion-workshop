// The message modules the helper on a person's computer carries (computer/connections/*), with fake outside effects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appleTime, imessage, textFromAttributedBody } from '../computer/connections/imessage.mjs';
import { audioOf, importVoiceNote, jidFor, whatsapp, wordsOf } from '../computer/connections/whatsapp.mjs';

const settings = JSON.parse(readFileSync(new URL(import.meta.resolve('../../run-on-a-persons-computer/carry-connections.json')), 'utf8'));
const row = vendor => settings.connections.find(item => item.vendor === vendor);

test('iMessage sends through AppleScript with the recipient and words as argv, never inside the script', async () => {
  const calls = [];
  const run = async (script, argv) => { calls.push({ script, argv }); return argv.length ? { code: 0, out: 'SENT', err: '' } : { code: 0, out: 'E:me@example.com', err: '' }; };
  const connection = imessage(row('imessage'), { run });
  assert.deepEqual(await connection.start(), { carried: true, account: 'me@example.com' });
  const hostile = 'hi" & (do shell script "rm -rf ~") & "';
  const answer = await connection.send({ to: 'me', owner_identity: 'me@example.com', text: hostile, link: 'https://example.com' });
  assert.equal(answer.sent, true);
  assert.equal(answer.to, 'me@example.com');
  const send = calls.at(-1);
  assert.deepEqual(send.argv, ['me@example.com', `${hostile}\nhttps://example.com`]);
  assert.ok(!send.script.includes(hostile));
});

test('iMessage refuses a self notice when the Mac account is not the verified Trillion owner', async () => {
  const calls = [];
  const connection = imessage(row('imessage'), { run: async (script, argv) => {
    calls.push(argv);
    return argv.length ? { code: 0, out: 'SENT', err: '' } : { code: 0, out: 'E:another-person@example.com', err: '' };
  } });
  await connection.start();
  assert.equal((await connection.send({ to: 'me', owner_identity: 'owner@example.com', text: 'private notice' })).sent, false);
  assert.equal((await connection.send({ to: 'me', text: 'private notice' })).sent, false);
  assert.equal(calls.filter(argv => argv.length).length, 0, 'no AppleScript send reaches the other account');
});

test('iMessage names the macOS setting when it is refused, and reports no account as not carried', async () => {
  const refused = imessage(row('imessage'), { run: async (_, argv) => (argv.length ? { code: 1, out: '', err: 'execution error: Not authorized to send Apple events to Messages. (-1743)' } : { code: 0, out: 'P:+15551234567', err: '' }) });
  await refused.start();
  assert.match((await refused.send({ to: 'me', owner_identity: '+15551234567', text: 'x' })).error, /Privacy & Security > Automation/);
  const waiting = imessage(row('imessage'), { run: async () => ({ code: 1, out: '', err: '', timed_out: true }) });
  assert.match((await waiting.start()).why, /Click Allow on that prompt/);
  const none = imessage(row('imessage'), { run: async () => ({ code: 0, out: 'missing value', err: '' }) });
  assert.equal((await none.start()).carried, false);
  const locked = imessage(row('imessage'), { run: async () => ({ code: 0, out: 'E:a@b.c', err: '' }), open: () => { throw new Error('unable to open database file: authorization denied'); } });
  assert.match((await locked.read({})).error, /Full Disk Access/);
});

test('iMessage reads recent messages newest first, with words from attributedBody when the text is empty', async () => {
  const words = Buffer.from('hello from the blob');
  const blob = Buffer.concat([Buffer.from('streamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+', 'latin1'), Buffer.from([words.length]), words, Buffer.from('\x86\x84\x02iI', 'latin1')]);
  let asked;
  const open = () => ({ prepare: sql => ({ all: (...params) => { asked = { sql, params }; return [{ text: null, body: blob, date: 780000000 * 1e9, mine: 0, handle: '+15551234567', chat: '+15551234567' }]; } }), close() {} });
  const connection = imessage(row('imessage'), { run: async () => ({ code: 0, out: 'E:a@b.c', err: '' }), open });
  const { messages } = await connection.read({ with: '5551234567', limit: 3 });
  assert.deepEqual(messages, [{ from: '+15551234567', chat: '+15551234567', at: appleTime(780000000 * 1e9), text: 'hello from the blob' }]);
  assert.deepEqual(asked.params, ['%5551234567%', '%5551234567%', '%5551234567%', 3]);
  assert.equal(appleTime(0), null);
  assert.equal(appleTime(780000000 * 1e9), '2025-09-19T18:40:00.000Z');
  assert.match(asked.sql, /CAST\(m\.date AS TEXT\)/, 'the date is read as text: node:sqlite refuses integers past 2^53');
  assert.equal(appleTime('813013115298131456'), appleTime(813013115298131456));
});

test('attributedBody lengths over 127 bytes use the two-byte and four-byte forms', () => {
  const long = Buffer.from('x'.repeat(300));
  const two = Buffer.concat([Buffer.from('NSString+', 'latin1'), Buffer.from([0x81, 300 & 0xff, 300 >> 8]), long]);
  assert.equal(textFromAttributedBody(two), 'x'.repeat(300));
  const four = Buffer.concat([Buffer.from('NSString+', 'latin1'), Buffer.from([0x82, 44, 1, 0, 0]), long]);
  assert.equal(textFromAttributedBody(four), 'x'.repeat(300));
  assert.equal(textFromAttributedBody(Buffer.from('no marker')), null);
});

test('WhatsApp addresses and words: me, a phone number, a jid, and every kind of message that carries words', () => {
  assert.equal(jidFor('me', '15555550100:15554240914@s.whatsapp.net'), '15555550100@s.whatsapp.net');
  assert.equal(jidFor('+1 555 555 0101', null), '15555550101@s.whatsapp.net');
  assert.equal(jidFor('user-4fe1a2fd@example.com', null), 'user-4fe1a2fd@example.com');
  assert.equal(jidFor('12', null), null);
  assert.equal(wordsOf({ conversation: 'a' }), 'a');
  assert.equal(wordsOf({ extendedTextMessage: { text: 'b' } }), 'b');
  assert.equal(wordsOf({ ephemeralMessage: { message: { imageMessage: { caption: 'c' } } } }), 'c');
  assert.equal(wordsOf({ reactionMessage: {} }), null);
});

test('WhatsApp voice notes keep their original audio in Files and expose its identity to every AI', async () => {
  const bytes = Buffer.from('voice-note-audio');
  let saved;
  const item = {
    key: { id: 'voice-note-1' },
    messageTimestamp: 1,
    message: { audioMessage: { ptt: true, seconds: 7, mimetype: 'audio/ogg; codecs=opus' } },
  };
  assert.deepEqual(audioOf(item.message), { kind: 'voice_note', duration_seconds: 7, media_type: 'audio/ogg; codecs=opus' });
  const audio = await importVoiceNote(item, {
    download: async message => { assert.equal(message, item); return bytes; },
    keepFile: async file => {
      saved = file;
      assert.deepEqual(Buffer.from(file.bytes), bytes);
      return { id: '1f:voice-note', name: file.name };
    },
  });
  assert.equal(saved.media_type, 'audio/ogg; codecs=opus');
  assert.equal(audio.kind, 'voice_note');
  assert.equal(audio.file_identity, '1f:voice-note');
  assert.match(audio.file_name, /^voice-note-/);
  assert.equal(await importVoiceNote({ message: { audioMessage: { ptt: false } } }, {}), null);
});

test('the connected WhatsApp reader imports an incoming voice note and returns its file identity', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'trillion-whatsapp-proof-'));
  const session = join(folder, 'session');
  mkdirSync(session, { recursive: true });
  writeFileSync(join(session, 'creds.json'), JSON.stringify({ registered: true }));
  const events = new Map();
  const bytes = Buffer.from('proof voice note audio');
  let uploadAttempts = 0;
  let downloads = 0;
  let cached = null;
  const item = {
    key: { id: 'proof-voice-1', remoteJid: '15555853910@s.whatsapp.net' },
    messageTimestamp: 1,
    message: { audioMessage: { ptt: true, seconds: 3, mimetype: 'audio/ogg' } },
  };
  const keepFile = async file => {
    uploadAttempts += 1;
    cached = Buffer.from(file.bytes);
    if (uploadAttempts === 1) throw new Error('temporary namespace reset');
    return { id: '1f:proof-voice-note', name: `/WhatsApp voice notes/${file.name}` };
  };
  keepFile.readCached = async () => cached;
  const connection = whatsapp({ ...row('whatsapp'), open_within_ms: 100 }, {
    folder,
    load: async () => ({
      default: () => {
        // Attach the real handlers before opening the fake socket. The fake must
        // not wait behind a timer phase while the Mac is busy with other checks.
        queueMicrotask(() => events.get('connection.update')({ connection: 'open' }));
        return { ev: { on: (name, listener) => events.set(name, listener) }, user: { id: '15555853910@s.whatsapp.net' } };
      },
      fetchLatestBaileysVersion: async () => ({ version: 'proof' }),
      useMultiFileAuthState: async () => ({ state: { creds: { registered: true } }, saveCreds() {} }),
      downloadMediaMessage: async message => {
        assert.equal(message, item);
        downloads += 1;
        if (downloads > 1) throw new Error('message media is no longer available');
        return bytes;
      },
    }),
    keepFile,
  });
  try {
    assert.equal((await connection.start()).carried, true);
    events.get('messages.upsert')({ messages: [item] });
    await new Promise(resolve => setImmediate(resolve));
    events.get('messages.upsert')({ messages: [item] });
    await new Promise(resolve => setImmediate(resolve));
    const { messages } = await connection.read({ limit: 5 });
    assert.equal(uploadAttempts, 2);
    assert.equal(downloads, 2);
    assert.equal(messages[0].audio.kind, 'voice_note');
    assert.equal(messages[0].audio.file_identity, '1f:proof-voice-note');
    assert.match(messages[0].audio.file_name, /^\/WhatsApp voice notes\/voice-note-/);
  } finally {
    connection.stop();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the WhatsApp helper starts a phone pairing on request and returns the one-time code without logging it', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'trillion-whatsapp-pairing-'));
  const events = new Map();
  const logs = [];
  const socket = {
    authState: { creds: { registered: false } },
    ev: { on: (name, listener) => events.set(name, listener) },
    requestPairingCode: async phone => { assert.equal(phone, '15555550102'); return 'AB12-CD34'; },
    end() {},
  };
  const connection = whatsapp({ ...row('whatsapp') }, {
    folder,
    log: event => logs.push(event),
    load: async () => ({
      default: () => socket,
      fetchLatestBaileysVersion: async () => ({ version: 'proof' }),
      useMultiFileAuthState: async () => ({ state: { creds: { registered: false } }, saveCreds() {} }),
    }),
  });
  try {
    assert.deepEqual(await connection.connect(), { state: 'needs_phone', error: row('whatsapp').words.phone_needed });
    const connecting = connection.connect({ phone: '+1 555 555 0102' });
    await new Promise(resolve => setImmediate(resolve));
    events.get('connection.update')({ qr: 'pairing-payload' });
    assert.deepEqual(await connecting, { state: 'pairing_required', code: 'AB12-CD34', expires_after_seconds: row('whatsapp').code_seconds });
    assert.equal(connection.carried(), false, 'the service is not connected until the person completes pairing');
    assert.equal(JSON.stringify(logs).includes('AB12-CD34'), false);
  } finally {
    connection.stop();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('an expired WhatsApp pairing code starts a fresh pairing window', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'trillion-whatsapp-expired-pairing-'));
  const sockets = [];
  let clock = 10_000;
  let codeNumber = 0;
  const connection = whatsapp({ ...row('whatsapp') }, {
    folder,
    now: () => clock,
    load: async () => ({
      default: () => {
        const events = new Map();
        const socket = {
          authState: { creds: { registered: false } },
          ev: { on: (name, listener) => events.set(name, listener) },
          requestPairingCode: async () => `CODE-${++codeNumber}`,
          end() {},
        };
        sockets.push({ socket, events });
        return socket;
      },
      fetchLatestBaileysVersion: async () => ({ version: 'proof' }),
      useMultiFileAuthState: async () => ({ state: { creds: { registered: false } }, saveCreds() {} }),
    }),
  });
  try {
    const first = connection.connect({ phone: '+1 555 555 0103' });
    await new Promise(resolve => setImmediate(resolve));
    sockets[0].events.get('connection.update')({ qr: 'first-pairing-payload' });
    assert.deepEqual(await first, { state: 'pairing_required', code: 'CODE-1', expires_after_seconds: row('whatsapp').code_seconds });

    mkdirSync(join(folder, 'session'), { recursive: true });
    writeFileSync(join(folder, 'session', 'creds.json'), JSON.stringify({ registered: false }));
    clock += (row('whatsapp').code_seconds + 1) * 1000;
    const second = connection.connect({ phone: '+1 555 555 0103' });
    await new Promise(resolve => setImmediate(resolve));
    sockets[0].events.get('connection.update')({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 500 } } } });
    sockets[1].events.get('connection.update')({ qr: 'second-pairing-payload' });
    assert.deepEqual(await second, { state: 'pairing_required', code: 'CODE-2', expires_after_seconds: row('whatsapp').code_seconds });
    assert.equal(sockets.length, 2);
  } finally {
    connection.stop();
    rmSync(folder, { recursive: true, force: true });
  }
});
