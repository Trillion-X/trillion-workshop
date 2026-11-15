// test/inbound-door.test.mjs
// What a carrier sends to the one door is checked once as it arrives (src/inbound.mjs arrivalAtTheDoor, fields in
// src/inbound-fields.json): a wrong kind is refused naming every wrong field, a field nobody reads is left out and named
// back, and no input whatever, however malformed, does anything but answer or refuse in words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { arrivalAtTheDoor, InboundError } from '../read-data/inbound.mjs';

test('known fields pass through, unread ones are named back, wrong kinds are refused together', () => {
  const { arrival, ignored_fields } = arrivalAtTheDoor({ route: 'Notes', source_id: 'n1', text: 'hi', at: '2026-10-05T07:00:00Z', voice: { me: true, score: 0.9 }, colour: 'blue', follows: 'h_1' });
  assert.deepEqual(arrival, { route: 'Notes', source_id: 'n1', text: 'hi', at: '2026-10-05T07:00:00Z', voice: { me: true, score: 0.9 } });
  assert.deepEqual(ignored_fields, ['colour', 'follows'], 'a carrier cannot set what only Trillion says (follows), and learns colour is read by nobody');
  assert.throws(() => arrivalAtTheDoor({ route: 5, text: ['a'], from_person: 'yes' }), /route must be text; text must be text; from_person must be true or false/);
});

test('nested arrival fields are checked at the door, including every file entry', () => {
  assert.deepEqual(arrivalAtTheDoor({ files: [{ id: 'file-1', name: 'clip.mp4' }], voice: { me: false, score: 0.8 } }), {
    arrival: { files: [{ id: 'file-1', name: 'clip.mp4' }], voice: { me: false, score: 0.8 } }, ignored_fields: [],
  });
  assert.deepEqual(arrivalAtTheDoor({ voice: { me: false, named: false, score: 0.468, unsure: ['Sam'] } }).arrival.voice,
    { me: false, named: false, score: 0.468, unsure: ['Sam'] }, 'the installed listener may keep an uncertain voice without losing the turn');
  assert.throws(() => arrivalAtTheDoor({ files: [null] }), /files\[0\] must be an object/);
  assert.throws(() => arrivalAtTheDoor({ files: [{ name: 'clip.mp4' }] }), /files\[0\]\.id is required/);
  assert.throws(() => arrivalAtTheDoor({ files: [{ id: 'file-1', owner: 'other' }] }), /files\[0\]\.owner is not a field this door reads/);
  assert.throws(() => arrivalAtTheDoor({ voice: { me: 'yes' } }), /voice\.me must be true or false/);
  assert.throws(() => arrivalAtTheDoor({ voice: { verified: true } }), /voice\.verified is not a field this door reads/);
  assert.throws(() => arrivalAtTheDoor({ voice: JSON.parse('{"constructor":true}') }), /voice\.constructor is not a field this door reads/);
  assert.throws(() => arrivalAtTheDoor({ voice: JSON.parse('{"__proto__":{"me":true}}') }), /voice\.__proto__ is not a field this door reads/);
  assert.throws(() => arrivalAtTheDoor({ files: [JSON.parse('{"id":"file-1","constructor":true}')] }), /files\[0\]\.constructor is not a field this door reads/);
  assert.throws(() => arrivalAtTheDoor({ files: [JSON.parse('{"id":"file-1","__proto__":{"id":"other"}}')] }), /files\[0\]\.__proto__ is not a field this door reads/);
});

// A seeded generator, so a failure is the same failure on every run.
function seeded(seed) {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
}
function anything(random, depth = 0) {
  const pick = Math.floor(random() * 9);
  if (depth > 3) return null;
  switch (pick) {
    case 0: return null;
    case 1: return random() < 0.5;
    case 2: return (random() - 0.5) * 1e12;
    case 3: return String.fromCharCode(...Array.from({ length: Math.floor(random() * 12) }, () => Math.floor(random() * 0xffff)));
    case 4: return Array.from({ length: Math.floor(random() * 4) }, () => anything(random, depth + 1));
    case 5: return Number.NaN;
    default: {
      const keys = ['route', 'source_id', 'text', 'at', 'files', 'voice', 'from_person', 'chat_first_minutes', '__proto__', 'constructor', 'x'];
      return Object.fromEntries(Array.from({ length: Math.floor(random() * 6) }, () => [keys[Math.floor(random() * keys.length)], anything(random, depth + 1)]));
    }
  }
}

test('ten thousand malformed arrivals: each is answered or refused in words, never a crash', () => {
  const random = seeded(20261005);
  for (let index = 0; index < 10_000; index += 1) {
    const sent = anything(random);
    try {
      const { arrival, ignored_fields } = arrivalAtTheDoor(sent);
      assert.equal(typeof arrival, 'object');
      assert.ok(Array.isArray(ignored_fields));
      assert.equal(Object.getPrototypeOf(arrival), Object.prototype, 'no field can change what an arrival is');
    } catch (error) {
      assert.ok(error instanceof InboundError, `input ${index} threw ${error?.constructor?.name}: ${error?.message}`);
    }
  }
});

test('a hybrid timestamp is an admitted event field and malformed clock shapes are refused by the owner', () => {
  const clock = { wall_ms: 1790000000000, logical: 4, device_id: 'phone' };
  const { arrival } = arrivalAtTheDoor({ route: 'Notes', source_id: 'n2', text: 'continue', at: '2026-10-05T07:00:00Z', clock });
  assert.deepEqual(arrival.clock, clock);
  assert.throws(() => arrivalAtTheDoor({ route: 'Notes', source_id: 'n3', text: 'bad', at: '2026-10-05T07:00:00Z', clock: [] }), /clock must be an object/);
});


test('a file sent with its media type passes the door (the Mac reader sends one with every recording and note)', () => {
  const { arrival } = arrivalAtTheDoor({ route: 'Voice Memos', source_id: 'memo-1', text: 'A memo', at: '2026-10-06T00:00:00.000Z', files: [{ id: 'f1', name: 'memo.m4a', media_type: 'audio/mp4' }] });
  assert.equal(arrival.files[0].media_type, 'audio/mp4');
});
