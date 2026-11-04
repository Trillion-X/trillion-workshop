// Inspiration (src/inspiration.mjs over src/inspiration.json): each source is read once, a row keeps the items its
// tests pass, cards open what they came from, a failed source marks only its own rows, and the words say what there is.
import assert from 'node:assert/strict';
import test from 'node:test';
import { inspiration } from '../../inspiration.mjs';
import settings from '../../inspiration.json' with { type: 'json' };

const clip = (identity, extra = {}) => ({ identity, file: identity, title: identity, media_kind: 'video', duration: 30, captured_ms: Date.parse('2026-10-01T10:00:00Z'), ...extra });

function sources(overrides = {}) {
  const reads = {};
  const answers = {
    pick: { pick: { title: 'Make this next', reason: 'Two talking clips', clips: [clip('1f:a')] } },
    library: { rows: [clip('1f:b'), clip('1f:c', { used_by_edit: true })] },
    recent: { items: [{ identity: '1f:d', name: 'notes.md', last_at: '2026-10-01T11:00:00Z', last_words: 'Opened' }] },
    formats: { formats: [{ id: 'x-thread', label: 'X thread', description: 'A thread' }] },
    examples: { examples: [] },
    posts: { posts: [] },
    ...overrides,
  };
  return { reads, read: Object.fromEntries(Object.keys(answers).map(name => [name, async () => {
    reads[name] = (reads[name] ?? 0) + 1;
    if (answers[name] instanceof Error) throw answers[name];
    return answers[name];
  }])) };
}

test('every row the DATA names is answered, each source read once, and cards open what they came from', async () => {
  const { read, reads } = sources();
  const shown = await inspiration(read);
  assert.deepEqual(shown.sections.map(section => section.id), settings.sections.map(section => section.id));
  for (const count of Object.values(reads)) assert.equal(count, 1);
  const pick = shown.sections.find(section => section.id === 'pick');
  assert.equal(pick.title, 'Make this next', 'the pick names itself from its answer');
  assert.deepEqual(pick.cards[0].opens, { screen: 'trillion.file', input: { id: '1f:a' } });
  assert.equal(pick.cards[0].edit, true, 'a clip with a length can be edited from its card');
  const formats = shown.sections.find(section => section.id === 'formats');
  assert.equal(formats.cards[0].title, 'X thread');
  assert.match(shown.said, /make from/);
});

test('a source that fails marks only its own rows; with nothing at all the words say so', async () => {
  const { read } = sources({ library: new Error('store is resetting') });
  const shown = await inspiration(read);
  const failed = shown.sections.filter(section => section.failed);
  assert.ok(failed.length > 0);
  assert.ok(failed.every(section => settings.sections.find(row => row.id === section.id).read.from === 'library'));
  const empty = await inspiration(sources({ pick: {}, library: {}, recent: {}, formats: {}, examples: {}, posts: {} }).read);
  assert.ok(empty.sections.every(section => section.cards.length === 0));
  assert.match(empty.said, /^Nothing to make from yet/);
});
