/**
 * packages/visual-database/do-work/__tests__/extract-dm-leads.test.mjs
 *
 * The predecessor was 170 lines of python inlined as base64 inside
 * things-to-store-and-run.json. It hardcoded a closed keyword list, two channel
 * names, per-channel identity formats and per-channel provenance field names. A new
 * channel or a new buying-intent word meant editing code that no file search could
 * find and no test covered.
 *
 * These tests hold the property that replaced it: every one of those is DATA.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from '../process-scripts/extract-dm-leads.mjs';

const DESCRIPTOR = {
  default_channel: 'direct-message',
  default_event_type: 'dm-inbound',
  identity_template: '{channel}:{thread_ref}',
  self_fields: ['self_jid', 'self_pk'],
  handle_fields: ['handle', 'contact_name'],
  channel_rules: [
    { channel: 'ig', thread_ref_contains: 'ig-thread', identity_template: 'ig:{handle}' },
  ],
  signals: [
    { key: 'contact-shared', event_type: 'dm-lead-candidate',
      patterns: [{ regex: '[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}' }] },
    { key: 'buying-interest', event_type: 'dm-lead-candidate',
      patterns: [{ phrase: 'how much' }] },
  ],
};

const atom = (over = {}) => ({
  thread_ref: 'thread-1', speaker_ref: 'them', at: '2026-09-03T00:00:00Z',
  atom_ref: 'atom:1', content: 'hello', ...over,
});

const eventsOf = (result) => result.writes.filter((w) => w.payload.kind === 'lead-event');
const customersOf = (result) => result.writes.filter((w) => w.payload.kind === 'customer');

test('an inbound thread becomes one customer row and one lead-event row', () => {
  const result = build([{ atoms: [atom()] }], DESCRIPTOR);
  assert.equal(customersOf(result).length, 1);
  assert.equal(eventsOf(result).length, 1);
  assert.equal(result.counts.threads_scanned, 1);
  assert.equal(result.counts.customers, 1);
});

test('our own messages are not leads, and which provenance field names us is DATA', () => {
  const mine = atom({ speaker_ref: 'acct-9', provenance: { self_jid: 'acct-9' } });
  assert.equal(customersOf(build([{ atoms: [mine] }], DESCRIPTOR)).length, 0);
  // A descriptor that does not declare that field no longer recognises us.
  const blind = { ...DESCRIPTOR, self_fields: [] };
  assert.equal(customersOf(build([{ atoms: [mine] }], blind)).length, 1);
});

test('a NEW buying-intent phrase is one DATA row and needs zero code change', () => {
  const said = atom({ content: 'what is the turnaround' });
  assert.equal(eventsOf(build([{ atoms: [said] }], DESCRIPTOR))[0].payload.event_type, 'dm-inbound');

  const widened = {
    ...DESCRIPTOR,
    signals: [...DESCRIPTOR.signals,
      { key: 'buying-interest', event_type: 'dm-lead-candidate', patterns: [{ phrase: 'turnaround' }] }],
  };
  const event = eventsOf(build([{ atoms: [said] }], widened))[0].payload;
  assert.equal(event.event_type, 'dm-lead-candidate');
  assert.equal(event.signal_key, 'buying-interest');
});

test('a NEW channel is one DATA row: identity shape and detection both come from the descriptor', () => {
  const fromNewChannel = atom({ thread_ref: 'sms-thread-77', provenance: { handle: 'jo' } });
  // Unknown to the descriptor: falls back to the default channel, never to a guess.
  assert.equal(customersOf(build([{ atoms: [fromNewChannel] }], DESCRIPTOR))[0].payload.channel, 'direct-message');

  const widened = {
    ...DESCRIPTOR,
    channel_rules: [...DESCRIPTOR.channel_rules,
      { channel: 'sms', thread_ref_contains: 'sms-thread', identity_template: 'sms:{handle}' }],
  };
  const customer = customersOf(build([{ atoms: [fromNewChannel] }], widened))[0].payload;
  assert.equal(customer.channel, 'sms');
  assert.equal(customer.id, 'sms:jo');
});

test('a decoder that names its own channel is believed over any descriptor rule (L090)', () => {
  // The decoder produced the atom and knows what it decoded. Guessing from substrings
  // of a thread ref is what forced every new channel into the code before.
  const declared = atom({ thread_ref: 'ig-thread-4', provenance: { channel: 'authoritative', handle: 'x' } });
  assert.equal(customersOf(build([{ atoms: [declared] }], DESCRIPTOR))[0].payload.channel, 'authoritative');
});

test('signal precedence is authored DATA order, not the order of if-statements', () => {
  const both = atom({ content: 'how much? reach me at person@example.com' });
  const contactFirst = eventsOf(build([{ atoms: [both] }], DESCRIPTOR))[0].payload.signal_key;
  const flipped = { ...DESCRIPTOR, signals: [...DESCRIPTOR.signals].reverse() };
  const interestFirst = eventsOf(build([{ atoms: [both] }], flipped))[0].payload.signal_key;
  assert.equal(contactFirst, 'contact-shared');
  assert.equal(interestFirst, 'buying-interest');
});

test('an empty descriptor classifies nothing and invents nothing', () => {
  // The honest empty state. It must not fall back to some default vocabulary.
  const result = build([{ atoms: [atom({ content: 'how much for a lesson? person@example.com' })] }], {
    signals: [], channel_rules: [], self_fields: [], handle_fields: [],
  });
  assert.equal(eventsOf(result)[0].payload.signal_key, null);
  assert.equal(result.counts.signalled, 0);
});

test('a malformed signal pattern degrades to no-match instead of crashing the run', () => {
  const broken = { ...DESCRIPTOR, signals: [{ key: 'bad', patterns: [{ regex: '([unclosed' }] }] };
  const result = build([{ atoms: [atom({ content: 'anything' })] }], broken);
  assert.equal(eventsOf(result)[0].payload.signal_key, null);
});

test('the extractor names no channel and no business vocabulary', () => {
  const source = readFileSync(new URL('../process-scripts/extract-dm-leads.mjs', import.meta.url), 'utf8').toLowerCase();
  for (const word of ['instagram', 'whatsapp', 'telegram', 'price', 'cost', 'coach', 'lesson', 'sign up', 'interested']) {
    assert.equal(source.includes(word), false, `extractor must not name "${word}" — it belongs in the descriptor DATA`);
  }
});
