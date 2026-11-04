// test/duplicate-prompts-are-one-message.test.mjs
// A transcript hook and a carrier each record a prompt once, and a retry records it again a moment later with a time of
// its own: on 2026-10-08, 65 prompts in a day were kept two to five times, and each copy opened a decision and a job.
// The same words from the same speaker in the same conversation within five minutes are one message (src/messages.mjs
// 2a), found by a key made of the three and a five-minute slot (one point read), never by looking through the conversation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localStore } from '../src/local-store.mjs';
import { messages } from '../src/messages.mjs';

const CONVERSATION = 'claude-code:s-1';
const at = minutes => new Date(Date.parse('2026-10-06T06:00:00.000Z') + minutes * 60000).toISOString();
const item = over => ({ app: 'Claude Code', conversation_id: CONVERSATION, speaker: 'person', text: 'Please fix the intake door.', at: at(0), ...over });
const kept = (eeaf, conversation = CONVERSATION) => eeaf.fields.idsWhere('message', 'conversation_id', conversation);

test('the same words within five minutes, sent with another time, are the message already kept', () => {
  const { eeaf } = localStore(':memory:');
  const door = messages(eeaf);
  const first = door.record({ messages: [item()] });
  assert.equal(first.recorded, 1);
  const again = door.record({ messages: [item({ at: at(2) })] });
  assert.equal(again.recorded, 0);
  assert.deepEqual(again.ids, first.ids, 'the copy is the first message, not a second one');
  const earlier = door.record({ messages: [item({ at: at(-3) })] });
  assert.deepEqual(earlier.ids, first.ids, 'a copy that says an earlier time is the same message too');
  assert.equal(kept(eeaf).length, 1);
  assert.equal(eeaf.read(first.ids[0]).at, at(0), 'the first time stands');
});

test('words repeated after the window, by another speaker, in another conversation, or changed are new messages', () => {
  const { eeaf } = localStore(':memory:');
  const door = messages(eeaf);
  const first = door.record({ messages: [item()] }).ids[0];
  const later = door.record({ messages: [item({ at: at(6) })] }).ids[0];
  assert.notEqual(later, first, 'six minutes on, the same words are said again');
  const ai = door.record({ messages: [item({ speaker: 'ai', at: at(1) })] }).ids[0];
  const other = door.record({ messages: [item({ conversation_id: 'claude-code:s-2', at: at(1) })] }).ids[0];
  const changed = door.record({ messages: [item({ text: 'Please fix the intake door now.', at: at(1) })] }).ids[0];
  assert.equal(new Set([first, later, ai, other, changed]).size, 5);
  assert.equal(kept(eeaf).length, 4);
});

test('only the person\'s words in a transcript-owned app are folded; a chat in any other app can say "yes" twice', () => {
  const { eeaf } = localStore(':memory:');
  const door = messages(eeaf);
  const chat = over => item({ app: 'Telegram', conversation_id: 'telegram:c-1', text: 'yes', ...over });
  const first = door.record({ messages: [chat()] });
  const again = door.record({ messages: [chat({ at: at(1) })] });
  assert.equal(again.recorded, 1, 'the person said yes again in a chat app');
  assert.notEqual(again.ids[0], first.ids[0]);
  for (const app of ['WhatsApp', 'Messages', 'Listening']) {
    const said = over => item({ app, conversation_id: `${app}:c-1`, text: 'yes', ...over });
    const once = door.record({ messages: [said()] }, { road: 'carrier_door' });
    const twice = door.record({ messages: [said({ at: at(0.5) })] }, { road: 'carrier_door' });
    assert.notEqual(twice.ids[0], once.ids[0], `${app}: the person said yes twice within a minute`);
  }
  const hook = over => item({ text: 'yes', at: at(40), ...over });
  const recordedTwice = [door.record({ messages: [hook()] }, { road: 'carrier_door' }), door.record({ messages: [hook({ at: at(40.5) })] }, { road: 'unspecified' })];
  assert.equal(recordedTwice[1].recorded, 0, 'the hook recording the same prompt twice, by either road, is one message');
  assert.equal(recordedTwice[1].ids[0], recordedTwice[0].ids[0]);
  const reply = over => item({ speaker: 'ai', source_ref: undefined, ...over });
  const ai = door.record({ messages: [reply({ text: 'Done.' }), reply({ text: 'Done.', at: at(1) })] });
  assert.equal(new Set(ai.ids).size, 2, 'an AI saying the same thing twice is two messages');
});

test('copies in one batch are one message, and an item named by its source_ref is kept by that, not by its words', () => {
  const { eeaf } = localStore(':memory:');
  const door = messages(eeaf);
  const batch = door.record({ messages: [item({ at: at(10) }), item({ at: at(11) }), item({ at: at(12) })] });
  assert.equal(batch.recorded, 1);
  assert.equal(new Set(batch.ids).size, 1);
  const named = door.record({ messages: [item({ source_ref: 'node-1', text: 'Same words', at: at(20) }), item({ source_ref: 'node-2', text: 'Same words', at: at(21) })] });
  assert.equal(named.recorded, 2, 'two places at the source with the same words are two messages');
});

test('finding the earlier copy costs the same in a conversation of 20 messages and of 80', () => {
  const costOf = size => {
    const { eeaf } = localStore(':memory:');
    const build = messages(eeaf);
    for (let n = 0; n < size; n += 1) build.record({ messages: [item({ text: `Message number ${n}`, at: at(30 + n * 10) })] });
    let looked = 0;
    const { fields, read } = eeaf;
    const counted = {
      ...fields,
      fieldsOf: (type, ids, names) => { looked += ids.length; return fields.fieldsOf(type, ids, names); },
      idsWhere: (...args) => { looked += 1000; return fields.idsWhere(...args); },
    };
    eeaf.read = id => { looked += 1; return read.call(eeaf, id); };
    const probe = messages(eeaf, { fields: counted });
    const copy = probe.record({ messages: [item({ text: `Message number ${size - 1}`, at: at(30 + (size - 1) * 10 + 2) })] });
    eeaf.read = read;
    assert.equal(copy.recorded, 0, 'the last message said again is the one kept');
    return looked;
  };
  const small = costOf(20);
  const large = costOf(80);
  assert.equal(large, small, `finding a copy read ${small} records in 20 messages and ${large} in 80`);
});
