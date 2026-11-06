// Ported from old trillion test/erasable-fields.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. The stores are this tool's (src/record-engine.mjs, parts/record-log) and the device copy's
// settle is tools/record-log/do-work/record-sync.mjs. Left out, not ported here: the search-index steps of the first test
// (old src/record-search-index.mjs, gone from the JS tree; the engine's word index is trillion-rust
// src/storage/record_store/search.rs) and the test of rewriting a kept history file in its place (old
// src/record-history.mjs, gone from the JS tree; its owner is trillion-rust src/storage/record_store/history_archive.rs
// and history_chain.rs). Every other assertion is the old one.
// test/erasable-fields.test.mjs
// A field the record model declares erasable (a message's text first) is kept so that erasing its record leaves its words
// readable nowhere: not in the log's rows, not in a later row's record of what it replaced (envelope prior/was), not in
// the record's history, not in a sealed generation (what the history archive holds), not in the search index, and not
// in a device's copy once it settles again. A message that was not erased reads as before everywhere.
// Decision: source:cmVjb3JkLWVyYXN1cmUtMjAyNi0xMC0xMQ (declared-erasable-fields).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { canonical, identityOf } from '../src/decision-store.mjs';
import { openRecords, RECORD_MODEL, RECORD_INDEXES } from '../src/record-engine.mjs';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';
import { answerSettle, copyPositions, settleWith } from '../../record-log/do-work/record-sync.mjs';

const ERASED = 'violetheron';
const KEPT = 'amberfinch';
const text = value => (typeof value === 'string' ? value : value instanceof Uint8Array ? new TextDecoder().decode(value) : '');
const tables = sql => sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map(table => table.name);
// The tables of `sql` that hold `words` in any value.
const holding = (sql, words) => tables(sql).filter(name => sql.exec(`SELECT * FROM "${name}"`).toArray()
  .some(row => Object.values(row).some(value => text(value).includes(words))));
// The tables of `sql` that keep a key (base64), as text or as its bytes.
const keeping = (sql, key) => {
  const bytes = Buffer.from(key, 'base64');
  return tables(sql).filter(name => sql.exec(`SELECT * FROM "${name}"`).toArray().some(row => Object.values(row).some(value =>
    (typeof value === 'string' && value.includes(key)) || (value instanceof Uint8Array && Buffer.from(value).includes(bytes)))));
};
const envelopesOf = sql => tables(sql).filter(name => name === 'record_log' || name.startsWith('record_log_sealed'))
  .flatMap(name => sql.exec(`SELECT envelopes FROM "${name}"`).toArray().flatMap(row => JSON.parse(text(row.envelopes))));
const inputCopies = id => (RECORD_MODEL.kinds.find(kind => kind.type === 'message')?.erase_with ?? [])
  .filter(target => typeof target.id === 'string' && typeof target.type === 'string').map(target => target.id.replaceAll('{id}', id));
const inputSource = id => ({ app: 'erasure-proof', conversation_id: `${id}:${ERASED}`, source_ref: `original:${id}:${ERASED}` });
const inputSourceId = id => {
  const { app, conversation_id, source_ref } = inputSource(id);
  return `resource-input-source:${identityOf(canonical([app, conversation_id, source_ref]))}`;
};
const inputRecords = id => [
  { id: inputCopies(id)[0], type: 'resource-input-provenance', value: { message_id: id, source: { text: ERASED }, classified: { text: ERASED } } },
  { id: inputCopies(id)[1], type: 'resource-input-interpretation', value: { message_id: id, state: 'completed', outcome: { text: ERASED }, previous_outcome: { text: ERASED } } },
  { id: inputCopies(id)[2], type: 'ask-again', value: { message_id: id, at: '2026-10-13T12:00:00.000Z', facts: { route: ERASED, text: ERASED } } },
  { id: inputSourceId(id), type: 'resource-input-source', value: { message_id: id, ...inputSource(id) } },
  { id: `message-thread-index:original:${id}`, type: 'message-thread-index', value: { message_id: id, app: 'erasure-proof', at: '2026-10-13T12:00:00.000Z', conversation_id: `${ERASED}:original-conversation` } },
];
const assertInputSourceErased = (records, id) => {
  assert.deepEqual(records.read(inputSourceId(id)), {
    message_id: id, app: 'erasure-proof', conversation_id: null, source_ref: null,
  }, 'source identity metadata remains while the private fields under its erased message key are unreadable');
  assert.equal(records.read(`message-thread-index:original:${id}`).conversation_id, null,
    'a retired thread cursor cannot retain the erased original conversation');
};
// Drives a store's idle work until an erasure's scrub of old rows is done (it is idle work, never the erase's request).
function scrubbed(store, id) {
  for (let wake = 0; wake < 200 && store.erasure(id) !== null && store.erasure(id) !== 'done'; wake += 1) store.maintain({ max_pages: 512 });
  return store.erasure(id);
}

test('an erased message is readable nowhere; one not erased reads as before', async () => {
  const leader = sqliteHost(':memory:');
  const records = openRecords(leader.sql, { transaction: leader.transaction });
  const actor = { actor: { by: 'erasure-proof' } };
  records.write([{ id: 'message:erased', type: 'message', value: { conversation_id: 'conversation-marker', speaker: 'person', text: `Please keep ${ERASED} between us.` } }], actor);
  records.write([{ id: 'message:kept', type: 'message', value: { conversation_id: 'conversation-marker', speaker: 'person', text: `The ${KEPT} stays.` } }], actor);
  records.write(inputRecords('message:erased'), actor);
  assert.deepEqual(records.read('ask-again:message:erased').facts, { route: ERASED, text: ERASED });
  assert.equal(records.read('message-thread-index:original:message:erased').conversation_id, `${ERASED}:original-conversation`);
  const writtenAt = new Date().toISOString();
  await new Promise(resolve => setTimeout(resolve, 5));
  // A later change to the erased message: its row records what it replaced (prior/was).
  records.write([{ id: 'message:erased', type: 'message', value: { conversation_id: 'conversation-marker', speaker: 'person', text: `Please keep ${ERASED} between us.`, captured_road: "later-change" } }], actor);
  assert.match(records.read('message:erased').text, new RegExp(ERASED), 'before erasure the message reads as written');

  // A device's copy settles before the erasure and holds both.
  const positions = copyPositions(leader.sql);
  const send = async request => JSON.parse(JSON.stringify(leader.transaction(() => answerSettle(records, JSON.parse(JSON.stringify(request)), { positions }))));
  const device = sqliteHost(':memory:');
  const copy = recordLogStore(device.sql, { transaction: device.transaction });
  const settled = await settleWith(copy, send, { id: 'device-1' });
  assert.match(copy.read('message:erased').text, new RegExp(ERASED), 'the copy read the message before it was erased');

  // A sealed generation: what the history archive keeps as files.
  assert.ok(records.sealLog(), 'the rows written so far are a sealed generation');
  assert.ok(holding(leader.sql, 'conversation-marker').some(name => name.startsWith('record_log_sealed_')), 'the scan reads the sealed rows (a field that is not erasable is there)');

  // Before erasure the words are kept only sealed: no log row, sealed generation or page holds them (the search index
  // does, as words, until the record is forgotten there).
  assert.deepEqual(holding(leader.sql, ERASED).filter(name => !name.startsWith('search_')), [], 'the log, its generations and pages hold only the sealed form');
  assert.deepEqual(holding(device.sql, ERASED), [], 'the copy holds only the sealed form');
  assert.equal(records.secureDelete(), true, 'the key table overwrites an erased key (secure_delete granted on node SQLite; the deploy guard in workerd states it for Durable Objects)');

  const erasedKey = records.erasureKeys(['message:erased'])['message:erased'];
  assert.ok(typeof erasedKey === 'string' && keeping(device.sql, erasedKey).length > 0, 'the copy keeps the key it was sent');
  assert.deepEqual(records.erase('message:erased', actor), { erased: 'message:erased', also: inputCopies('message:erased'), scrub: 'scrubbing' });
  for (const id of inputCopies('message:erased')) assert.equal(records.read(id), null, 'input provenance and interpretations leave with their source message');
  assertInputSourceErased(records, 'message:erased');
  assert.equal(records.read('message:erased'), null, 'a sealed record is unreadable at once');
  assert.equal(scrubbed(records, 'message:erased'), 'done');
  await settleWith(copy, send, { id: 'device-1', state: settled.state });
  scrubbed(copy, 'message:erased');

  // 1. The log's rows (the open log and every sealed generation) and 2. what later rows record they replaced.
  assert.deepEqual(holding(leader.sql, ERASED), [], 'no table of the person store holds the erased words');
  for (const envelope of envelopesOf(leader.sql).filter(envelope => envelope.id === 'message:erased')) {
    for (const part of [envelope.value, envelope.set, envelope.prior, envelope.was]) assert.ok(!JSON.stringify(part ?? null).includes(ERASED), 'no envelope carries the erased words, in its value or in what it replaced');
  }
  // 3. History.
  assert.ok(!JSON.stringify(records.recordAt('message:erased', { known: writtenAt }) ?? null).includes(ERASED), 'history does not answer the erased words');
  assert.equal(records.read('message:erased'), null, 'the erased message reads as gone');
  // 5. The device's copy, once it settles again.
  assert.deepEqual(holding(device.sql, ERASED), [], 'the copy holds the erased words nowhere');
  // The key itself: kept nowhere on either side (no log row, record entry, page or table), pages written out first.
  records.checkpoint();
  copy.checkpoint();
  assert.deepEqual(keeping(leader.sql, erasedKey), [], 'the store keeps the erased key nowhere');
  assert.deepEqual(keeping(device.sql, erasedKey), [], 'the copy keeps the erased key nowhere');
  assert.ok(!JSON.stringify(copy.read('message:erased') ?? null).includes(ERASED));
  assertInputSourceErased(copy, 'message:erased');

  // A message that was not erased reads as before everywhere.
  assert.match(records.read('message:kept').text, new RegExp(KEPT));
  assert.match(JSON.stringify(records.recordAt('message:kept', { known: new Date().toISOString() })), new RegExp(KEPT));
  assert.match(copy.read('message:kept').text, new RegExp(KEPT));
});

test('a flagged field applied as words is kept sealed, and the message text is declared erasable', () => {
  const leader = sqliteHost(':memory:');
  const records = openRecords(leader.sql, { transaction: leader.transaction });
  assert.deepEqual(records.erasableFields('message'), ['text'], 'the record model declares message text erasable');
  // Decided (source:cmVjb3JkLWVyYXN1cmUtMjAyNi0xMC0xMQ, after the first build refused them): a change the host applies
  // itself (undo, a layer, kept history put back) carrying the field as words is SEALED as it is applied, never refused.
  // The rule is that words are never stored; refusing would break undo, layers and restore for any message written
  // before the field was erasable. Do not turn this back into a refusal.
  records.applyChanges([{ envelopes: [{ id: 'message:raw', type: 'message', value: { conversation_id: 'conversation-marker', speaker: 'person', text: `raw ${ERASED}` }, prior: null }] }], actor());
  assert.deepEqual(holding(leader.sql, ERASED), []);
  assert.match(records.read('message:raw').text, new RegExp(ERASED));
});
const actor = () => ({ actor: { by: 'erasure-proof' } });

test('a message kept as words before its text was erasable is taken out of every row, page and copy when it is erased', async () => {
  const leader = sqliteHost(':memory:');
  // The store as it was before the flag: the same model without `erasable`.
  const before = { ...RECORD_MODEL, kinds: RECORD_MODEL.kinds.map(({ erasable: _erasable, ...kind }) => kind) };
  const earlier = recordLogStore(leader.sql, { transaction: leader.transaction, model: before, indexes: RECORD_INDEXES });
  earlier.write([{ id: 'message:old', type: 'message', value: { conversation_id: 'conversation-marker', speaker: 'person', text: `An old ${ERASED} message.` } }], actor());
  earlier.write([{ id: 'message:old', type: 'message', value: { conversation_id: 'conversation-marker', speaker: 'person', text: `An old ${ERASED} message.`, captured_road: 'later-change' } }], actor());
  earlier.write([{ id: 'message:old-kept', type: 'message', value: { conversation_id: 'conversation-marker', speaker: 'person', text: `An old ${KEPT} message.` } }], actor());
  earlier.checkpoint();
  assert.ok(holding(leader.sql, ERASED).includes('record_log'), 'before the flag the words were kept as words');
  // A device took the old plaintext before the flag.
  const positions = copyPositions(leader.sql);
  const device = sqliteHost(':memory:');
  const copy = recordLogStore(device.sql, { transaction: device.transaction });
  let records = earlier;
  const send = async request => JSON.parse(JSON.stringify(leader.transaction(() => answerSettle(records, JSON.parse(JSON.stringify(request)), { positions }))));
  const settled = await settleWith(copy, send, { id: 'device-1' });
  assert.match(copy.read('message:old').text, new RegExp(ERASED));
  assert.ok(earlier.sealLog(), 'the old rows are a sealed generation');

  // The store opens with the flag: the old message still reads, as words.
  records = openRecords(leader.sql, { transaction: leader.transaction });
  assert.match(records.read('message:old').text, new RegExp(ERASED));
  const writtenAt = new Date().toISOString();
  assert.equal(records.erase('message:old', actor()).scrub, 'scrubbing', 'the old rows are scrubbed as idle work');
  assert.equal(records.read('message:old'), null, 'the record is gone at once');
  assert.equal(scrubbed(records, 'message:old'), 'done', 'the idle pass over every log table finishes');
  records.checkpoint?.();
  await settleWith(copy, send, { id: 'device-1', state: settled.state });
  assert.equal(scrubbed(copy, 'message:old'), 'done', "the copy's own idle pass finishes too");

  assert.deepEqual(holding(leader.sql, ERASED), [], 'no table of the person store holds the old words');
  assert.ok(!JSON.stringify(records.recordAt('message:old', { known: writtenAt }) ?? null).includes(ERASED), 'history does not answer them');
  assert.deepEqual(holding(device.sql, ERASED), [], 'the copy that held them as words takes them out of its own rows');
  assert.match(records.read('message:old-kept').text, new RegExp(KEPT), 'an old message not erased reads as before');
  assert.match(copy.read('message:old-kept').text, new RegExp(KEPT));
});

test('a copy opened before it knew text was erasable writes a plain message: the leader keeps only the sealed form, and the device still reads its words', async () => {
  const leader = sqliteHost(':memory:');
  const records = openRecords(leader.sql, { transaction: leader.transaction });
  const positions = copyPositions(leader.sql);
  const send = async request => JSON.parse(JSON.stringify(leader.transaction(() => answerSettle(records, JSON.parse(JSON.stringify(request)), { positions }))));
  const device = sqliteHost(':memory:');
  // An old build: the device's store has no erasable fields, so it keeps and sends the words.
  const copy = recordLogStore(device.sql, { transaction: device.transaction });
  const settled = await settleWith(copy, send, { id: 'old-device' });
  copy.write([{ id: 'message:from-device', type: 'message', value: { conversation_id: 'conversation-marker', speaker: 'person', text: `Typed on the device: ${ERASED}.` } }], actor());
  copy.write([{ id: 'message:from-device', type: 'message', value: { conversation_id: 'conversation-marker', speaker: 'person', text: `Typed on the device, changed: ${ERASED}.` } }], actor());
  const again = await settleWith(copy, send, { id: 'old-device', state: settled.state });
  assert.equal(again.conflicts.length, 0, 'the sealed arrival applies without a conflict');

  assert.match(records.read('message:from-device').text, /changed/, 'the leader reads the latest words');
  assert.deepEqual(holding(leader.sql, ERASED), [], "the leader's rows, log and what they replaced hold only the sealed form");
  for (const envelope of envelopesOf(leader.sql).filter(envelope => envelope.id === 'message:from-device')) {
    for (const part of [envelope.value, envelope.set, envelope.prior, envelope.was]) assert.ok(!JSON.stringify(part ?? null).includes(ERASED));
  }
  assert.match(copy.read('message:from-device').text, /changed/, 'the device still reads its words');
  await settleWith(copy, send, { id: 'old-device', state: again.state });
  assert.match(copy.read('message:from-device').text, /changed/, 'and still does after settling again');
});

test('erasing a message erases every record holding its words with it, and a job kept before takes its old index key with it', async () => {
  const leader = sqliteHost(':memory:');
  // Before the flag: no field erasable, Home's index of open work still built its keys from a job's words, and neither
  // the index that carries them sealed nor the notices' index by job was kept yet.
  const before = { ...RECORD_MODEL, kinds: RECORD_MODEL.kinds.map(({ erasable: _erasable, ...kind }) => kind) };
  const oldIndexes = RECORD_INDEXES.filter(index => index.name !== 'home-open' && !(index.type === 'notice-list' && index.name === 'handoff')).map(({ retired: _retired, ...index }) => index);
  const earlier = recordLogStore(leader.sql, { transaction: leader.transaction, model: before, indexes: oldIndexes });
  const job = (said, message) => ({ handoff_id: 'h-old', job: `Look into ${said}`, said, asked: { job: `Look into ${said}` }, input: { arrived: { message_id: message }, said },
    found_by: { open: 1 }, handed_at: '2026-10-11T10:00:00.000Z', state: 'open', in_the_way: null, parent_handoff_id: null, from_agent: null });
  earlier.write([{ id: 'message:asked', type: 'message', value: { conversation_id: 'conversation-marker', speaker: 'person', text: `Find the ${ERASED} folder.` } }], actor());
  earlier.write([{ id: 'agent-handoff:h-old', type: 'agent-handoff', value: job(`the ${ERASED} folder`, 'message:asked') }], actor());
  // The notice an AI is shown for the job quotes its words (src/handoff-notice.mjs), one kept before the flag.
  const notice = seq => ({ item: { seq, kind: 'handoff-waiting', key: 'h-old', at: '2026-10-11T10:00:00.000Z', from_reader: null, for_reader: null, refs: { handoff_id: 'h-old' }, said: `New work for you: Look into the ${ERASED} folder` } });
  earlier.write([{ id: 'notices:1', type: 'notice-list', value: notice(1) }], actor());
  earlier.checkpoint();
  assert.ok(holding(leader.sql, ERASED).some(name => name.startsWith('record_keys')), 'before the flag the old job\'s words were in its index key');

  const records = openRecords(leader.sql, { transaction: leader.transaction });
  assert.ok(records.erasableFields('agent-handoff').some(field => JSON.stringify(field) === '["input","said"]'), 'a field within an object can be erasable');
  // Every record the message's words are copied into by construction.
  records.write([
    { id: 'arrival:asked', type: 'arrival', value: { message_id: 'message:asked', route: 'chat', job: `Find the ${ERASED} folder.`, said: `${ERASED} folder`, resolved_text: `Find the ${ERASED} folder.`, entities: [{ said: ERASED }], at: '2026-10-11T10:00:00.000Z' } },
    { id: 'message:copy', type: 'message', value: null },
    { id: 'message-duplicate-correction:message:copy', type: 'message-duplicate-correction', value: { duplicate_id: 'message:copy', kept_id: 'message:asked', evidence: 'same words', corrected_at: '2026-10-11T10:01:00.000Z', duplicate: { speaker: 'ai', text: `Find the ${ERASED} folder.` } } },
  ], actor());
  // A message corrected as not the person's: the new one names the one it replaced, whose words its correction keeps.
  records.write([
    { id: 'message:revised', type: 'message', value: { conversation_id: 'conversation-marker', speaker: 'peer', text: `Peer said ${KEPT}-${ERASED}.`, corrected_from: 'message:first' } },
    { id: 'message-provenance-correction:message:first', type: 'message-provenance-correction', value: { message_id: 'message:first', corrected_message_id: 'message:revised', speaker: 'peer', evidence: 'raw source', corrected_at: '2026-10-11T10:02:00.000Z', original: { speaker: 'person', text: `Peer said ${KEPT}-${ERASED}.` }, retired_arrival_ids: [] } },
  ], actor());
  records.write([{ id: 'message:other', type: 'message', value: { conversation_id: 'conversation-marker', speaker: 'person', text: `The ${KEPT} stays.` } }], actor());
  assert.equal(records.read('agent-handoff:h-old').said, `the ${ERASED} folder`, 'the old job still reads its words');
  records.write([{ id: 'notices:2', type: 'notice-list', value: notice(2) }], actor());
  // Home's index of open work and the notices' index by job are built over what was kept before: the open-work entry
  // carries the job's words sealed, and reads them opened.
  for (let wake = 0; wake < 50 && !(records.indexReady('agent-handoff', 'home-open') && records.indexReady('notice-list', 'handoff')); wake += 1) records.maintain({ max_pages: 512 });
  assert.deepEqual(records.scan('agent-handoff', 'home-open', { equal: [1], all: true, carried: true }).map(entry => entry.carried), [{ said: `the ${ERASED} folder` }]);
  assert.equal(records.read('message-duplicate-correction:message:copy').duplicate.text, `Find the ${ERASED} folder.`, 'a correction keeps the words it corrected, opened when read');

  const asked = records.erase('message:asked', actor());
  assert.deepEqual([asked.erased, ...asked.also].sort(), ['agent-handoff:h-old', 'arrival:asked', 'message-duplicate-correction:message:copy', 'message:asked', 'message:copy', 'notices:1', 'notices:2', ...inputCopies('message:asked'), ...inputCopies('message:copy')].sort());
  const revised = records.erase('message:revised', actor());
  assert.deepEqual(revised.also.sort(), ['message-provenance-correction:message:first', 'message:first', ...inputCopies('message:revised'), ...inputCopies('message:first')].sort(), 'the message it replaced, its input records and the correction keeping its words go with it');
  for (const id of [asked.erased, ...asked.also, revised.erased, ...revised.also]) assert.equal(scrubbed(records, id), 'done');
  records.checkpoint?.();

  assert.deepEqual(holding(leader.sql, ERASED), [], 'no row, page, index key or what a row replaced holds the words');
  for (const id of ['arrival:asked', 'agent-handoff:h-old', 'message-duplicate-correction:message:copy', 'message-provenance-correction:message:first', 'notices:1', 'notices:2']) assert.equal(records.read(id), null, `${id} is gone`);
  assert.match(records.read('message:other').text, new RegExp(KEPT), 'a message not erased reads as before');
  assert.deepEqual(records.scan('agent-handoff', 'home-open', { equal: [1], all: true }), [], 'the job left Home\'s open work');
});

test('a kind with no erasable fields is refused by name', () => {
  const leader = sqliteHost(':memory:');
  const records = openRecords(leader.sql, { transaction: leader.transaction });
  records.write([{ id: 'setting:x', type: 'setting', value: { value: 1 } }], actor());
  assert.throws(() => records.erase('setting:x', actor()), /setting/);
});

test('current message policy scrubs old plaintext retry facts and thread metadata after an original erasure', () => {
  const host = sqliteHost(':memory:');
  try {
    const before = { ...RECORD_MODEL, kinds: RECORD_MODEL.kinds.map(kind => {
      if (['ask-again', 'message-thread-index'].includes(kind.type)) {
        const { erasable: _fields, erasable_key: _key, ...plain } = kind;
        return plain;
      }
      if (kind.type === 'message') return { ...kind, erase_fields: [],
        erase_with: kind.erase_with.filter(row => row.type !== 'ask-again') };
      return kind;
    }) };
    const earlier = recordLogStore(host.sql, { transaction: host.transaction, model: before, indexes: RECORD_INDEXES });
    const id = 'message:original-private-retry';
    const retryId = `ask-again:${id}`;
    const threadId = `message-thread-index:original:${id}`;
    const marker = 'PRIVATE_ORIGINAL_CLASSIFIER_SOURCE_20261014';
    earlier.write([
      { id, type: 'message', value: { app: 'Notes', conversation_id: 'original-retry-conversation', speaker: 'person', text: marker } },
      { id: retryId, type: 'ask-again', value: { message_id: id, at: '2026-10-13T12:00:00.000Z', facts: { route: marker, text: marker } } },
      { id: threadId, type: 'message-thread-index', value: { message_id: id, app: 'Notes', at: '2026-10-13T12:00:00.000Z', conversation_id: marker } },
    ], actor());
    const originalKey = earlier.erasureKeys([id])[id];
    assert.equal(typeof originalKey, 'string');
    earlier.erase(id, actor());
    assert.equal(scrubbed(earlier, id), 'done');
    assert.equal(earlier.read(retryId).facts.text, marker, 'the original policy really left readable private retry facts');
    assert.equal(earlier.read(threadId).conversation_id, marker);
    assert.ok(holding(host.sql, marker).length > 0, 'the old source has real retained plaintext');

    const records = openRecords(host.sql, { transaction: host.transaction });
    for (let wake = 0; wake < 200; wake++) {
      const result = records.maintain({ max_pages: 512 });
      if (!result.more && records.erasure(id) === 'done') break;
    }
    assert.equal(records.read(id), null);
    assert.ok(!records.read(retryId)?.facts?.text, 'an erased original cannot be classified again from retained facts');
    assert.equal(records.read(threadId)?.conversation_id ?? null, null);
    assert.deepEqual(holding(host.sql, marker), [], 'no physical row, page, index or history envelope retains the original private metadata');
    const erasedKeys = {
      [id]: { erased: ['text', 'conversation_id', 'source_ref', 'origin', 'evidence', 'attachments'] },
      [retryId]: { erased: ['facts'] },
    };
    assert.deepEqual(records.erasureKeys([id, retryId, threadId]), erasedKeys, 'only original erasure evidence remains; no encryption key is reminted');
    assert.deepEqual(keeping(host.sql, originalKey), [], 'the original encryption key is retained by no physical value');
    const cold = openRecords(host.sql, { transaction: host.transaction });
    assert.equal(cold.read(id), null);
    assert.ok(!cold.read(retryId)?.facts?.text);
    assert.equal(cold.read(threadId)?.conversation_id ?? null, null);
    assert.deepEqual(cold.erasureKeys([id, retryId, threadId]), erasedKeys);
  } finally { host.db.close(); }
});

test('a key rides beside the log row that made it, never in its envelopes, survives a rebuild, leaves the row when the log is sealed, and an arrival is sealed under its message\'s key', () => {
  const leader = sqliteHost(':memory:');
  let records = openRecords(leader.sql, { transaction: leader.transaction });
  const rows = () => leader.sql.exec('SELECT rowid AS at, envelopes, keys FROM record_log ORDER BY rowid').toArray();
  const keyRow = id => leader.sql.exec('SELECT key FROM record_erasable_keys WHERE record_id = ?', id).toArray()[0] ?? null;
  records.write([{ id: 'message:kept-key', type: 'message', value: { conversation_id: 'conversation-marker', speaker: 'person', text: `Hold the ${KEPT} line.` } }], actor());
  records.write([{ id: 'arrival:kept-key', type: 'arrival', value: { message_id: 'message:kept-key', route: 'chat', job: `Hold the ${KEPT} line.`, at: '2026-10-11T10:00:00.000Z' } }], actor());
  const made = rows().find(row => row.keys);
  assert.deepEqual(Object.keys(JSON.parse(made.keys)), ['message:kept-key'], 'the message\'s key rides beside the row that made it; the arrival makes none (its message\'s key seals it)');
  assert.ok(!rows().some(row => row.envelopes.includes(JSON.parse(made.keys)['message:kept-key'])), 'no envelope holds the key');
  assert.equal(keyRow('message:kept-key'), null, 'the save path writes no key row of its own');
  assert.match(records.read('arrival:kept-key').job, new RegExp(KEPT));

  // A rebuild from the log (a crash before the pages were written out), then after they were.
  records = openRecords(leader.sql, { transaction: leader.transaction });
  assert.match(records.read('message:kept-key').text, new RegExp(KEPT), 'rebuilt from the log, the key is found beside its row');
  records.checkpoint();
  records = openRecords(leader.sql, { transaction: leader.transaction });
  assert.match(records.read('arrival:kept-key').job, new RegExp(KEPT));

  // Sealing the open log empties the keys beside its rows: the sealed generation holds none, and the key is kept with
  // the store's pages, written out in the same step.
  assert.ok(records.sealLog());
  assert.equal(keyRow('message:kept-key'), null, 'sealing writes no key row either');
  const sealed = leader.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'record_log_sealed_%'").toArray().map(row => row.name);
  for (const name of sealed) assert.deepEqual(leader.sql.exec(`SELECT keys FROM ${name} WHERE keys IS NOT NULL`).toArray(), [], `${name} holds no key`);
  records = openRecords(leader.sql, { transaction: leader.transaction });
  assert.match(records.read('message:kept-key').text, new RegExp(KEPT));

  // Erasing a message still in the open log takes its key out of the row at once; erasing it reaches its arrival.
  records.write([{ id: 'message:gone-key', type: 'message', value: { conversation_id: 'conversation-marker', speaker: 'person', text: `The ${ERASED} note.` } }], actor());
  records.write([{ id: 'arrival:gone-key', type: 'arrival', value: { message_id: 'message:gone-key', route: 'chat', job: `The ${ERASED} note.`, at: '2026-10-11T10:00:00.000Z' } }], actor());
  records.write(inputRecords('message:gone-key'), actor());
  const goneKey = rows().map(row => row.keys && JSON.parse(row.keys)['message:gone-key']).find(Boolean);
  assert.ok(goneKey && keeping(leader.sql, goneKey).length > 0, 'the scan reads where the key is kept');
  const erased = records.erase('arrival:gone-key', actor());
  assert.deepEqual([erased.erased, ...erased.also].sort(), ['arrival:gone-key', 'message:gone-key', ...inputCopies('message:gone-key')].sort(), 'an arrival erased alone takes its message and input records (the same words) with it');
  assert.ok(!rows().some(row => row.keys && JSON.parse(row.keys)['message:gone-key']), 'the key left its row');
  records = openRecords(leader.sql, { transaction: leader.transaction });
  assert.equal(records.read('message:gone-key'), null);
  assertInputSourceErased(records, 'message:gone-key');
  assert.equal(scrubbed(records, 'message:gone-key'), 'done');
  assert.deepEqual(holding(leader.sql, ERASED), []);
  records.checkpoint();
  assert.deepEqual(keeping(leader.sql, goneKey), [], 'the erased key is kept nowhere: not beside its row, not in any run of the key space');
  assert.equal(records.erasureKeysHeld('message:gone-key'), 0, 'neither the record\'s entry nor the key\'s own keeps it');
  assert.match(records.read('message:kept-key').text, new RegExp(KEPT), 'the other message reads as before');
});

test('an erased record\'s key is kept by no entry of the key space, in memory or in any run, nor by what reads opened, and a rebuild writes none back', () => {
  const leader = sqliteHost(':memory:');
  let records = openRecords(leader.sql, { transaction: leader.transaction });
  const id = 'message:stale-key';
  const value = said => ({ conversation_id: 'conversation-marker', speaker: 'person', text: said });
  records.write([{ id, type: 'message', value: value(`The ${ERASED} plan.`) }], actor());
  records.write([{ id: 'message:other-key', type: 'message', value: value(`The ${KEPT} plan.`) }], actor());
  const key = leader.sql.exec('SELECT keys FROM record_log WHERE keys IS NOT NULL ORDER BY rowid').toArray().map(row => JSON.parse(row.keys)[id]).find(Boolean);
  assert.match(records.read(id).text, new RegExp(ERASED));
  assert.ok(records.held().opened > 0, 'a read keeps what it opened');
  // One version of each entry in a run, and a newer one in memory.
  records.checkpoint();
  records.write([{ id, type: 'message', value: value(`The ${ERASED} plan, again.`) }], actor());
  assert.ok(records.erasureKeysHeld(id) >= 3, 'the key is kept beside the record and in its own entry, in a run and in memory');
  assert.ok(keeping(leader.sql, key).length > 0, 'the scan reads where the key is kept');

  records.erase(id, actor());
  assert.equal(records.held().opened, 0, 'erasing empties what reads opened');
  assert.equal(records.erasureKeysHeld(id), 0, 'no version of either entry keeps the key');
  // A rebuild from the log (the erasure not yet written out), then a scan of every table.
  records = openRecords(leader.sql, { transaction: leader.transaction });
  assert.equal(records.read(id), null);
  assert.equal(records.erasureKeysHeld(id), 0, 'a rebuild writes no key entry back');
  assert.equal(scrubbed(records, id), 'done');
  records.checkpoint();
  assert.equal(records.erasureKeysHeld(id), 0);
  assert.deepEqual(keeping(leader.sql, key), [], 'no table keeps the erased key');
  assert.deepEqual(holding(leader.sql, ERASED), []);
  assert.match(records.read('message:other-key').text, new RegExp(KEPT), 'the other message opens as before');
  assert.ok(records.held().opened > 0 && records.erasureKeysHeld('message:other-key') > 0);
});

test('a key made by a write that rolls back is never used: the next write makes one its own row keeps, and it reads back after a reset', () => {
  const leader = sqliteHost(':memory:');
  let failing = false;
  const sql = { exec(query, ...params) { if (failing && /^\s*INSERT INTO record_log\b/.test(query)) { failing = false; throw new Error('injected: the log row was not written'); } return leader.sql.exec(query, ...params); } };
  let records = openRecords(sql, { transaction: leader.transaction });
  const value = { conversation_id: 'conversation-marker', speaker: 'person', text: `After a fault, ${KEPT}.` };
  failing = true;
  assert.throws(() => records.write([{ id: 'message:after-fault', type: 'message', value }], actor()), /injected/);
  assert.equal(records.read('message:after-fault'), null, 'the failed write left nothing');
  records.write([{ id: 'message:after-fault', type: 'message', value }], actor());
  records = openRecords(leader.sql, { transaction: leader.transaction });
  assert.match(records.read('message:after-fault').text, new RegExp(KEPT), 'after a reset the words open: the key the write used is the one its row kept');
});
