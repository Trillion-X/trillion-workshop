import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { decisionStore } from '../src/decision-store.mjs';
import { setRecordEngine } from '../src/record-engine.mjs';
import { messages } from '../src/messages.mjs';

const at = index => new Date(Date.parse('2026-10-01T00:00:00Z') + index * 1000).toISOString();
const message = (index, conversation_id, extra = {}) => ({
  id: `message:${at(index)}:${String(index).padStart(24, '0')}`,
  type: 'message',
  value: { app: 'Codex', conversation_id, speaker: 'ai', text: `Reply ${index}`, at: at(index), ...extra },
});

function scenario(t, engine, rows) {
  const host = sqliteHost(':memory:');
  t.after(() => host.db.close());
  setRecordEngine(host.sql, engine);
  const { eeaf } = decisionStore(host.sql, { transaction: host.transaction });
  eeaf.write(rows, { actor: { by: 'test' } });
  const reads = [];
  let globalPages = 0;
  const observed = {
    ...eeaf,
    read(id) { reads.push(id); return eeaf.read(id); },
    readMany(ids) { reads.push(...new Set(ids)); return eeaf.readMany(ids); },
    ids(type, options) { if (type === 'message') globalPages += 1; return eeaf.ids(type, options); },
  };
  return { eeaf, owner: messages(observed), reads, globalPages: () => globalPages };
}

for (const engine of ['record-log', 'eeaf']) {
  test(`${engine}: a notification's older conversation is reachable beyond 1000 unrelated newer messages`, t => {
    const target = message(0, 'notified-conversation', { text: 'The requested result is ready.' });
    const unrelated = Array.from({ length: 1100 }, (_, index) => message(index + 1, `other-${index}`));
    const fixture = scenario(t, engine, [target, ...unrelated]);
    const result = fixture.owner.read({ app: 'Codex', conversation_id: 'notified-conversation', limit: 100 });

    assert.deepEqual(result.messages.map(row => row.id), [target.id], 'the message the notification refers to is returned immediately');
    assert.equal(result.next_before, null, 'unrelated history is not an older page of this conversation');
    assert.equal(result.looked_through, 1, 'the owner reads the selected conversation, not the global inbox');
    assert.deepEqual(fixture.reads, [target.id], 'only the selected message body is opened');
    assert.equal(fixture.globalPages(), 0, 'an exact conversation read uses its existing index');
  });

  test(`${engine}: conversation pages preserve app, speaker, words and linked-record filters`, t => {
    const rows = Array.from({ length: 31 }, (_, index) => message(index, 'shared-id', {
      app: index % 5 === 0 ? 'Another app' : 'Codex',
      speaker: index % 3 === 0 ? 'person' : 'ai',
      text: index % 2 === 0 ? `Needle ${index}` : `Other ${index}`,
      about: [{ kind: 'pursuit', id: index % 7 === 0 ? 'pursuit:other' : 'pursuit:one' }],
    }));
    const expected = rows.filter(row => row.value.app === 'Codex' && row.value.speaker === 'ai'
      && row.value.text.startsWith('Needle') && row.value.about[0].id === 'pursuit:one').map(row => row.id).reverse();
    const fixture = scenario(t, engine, rows);
    const found = [];
    const cursors = new Set();
    let before;
    do {
      const page = fixture.owner.read({ app: 'Codex', conversation_id: 'shared-id', speaker: 'ai', query: 'NEEDLE', about_id: 'pursuit:one', limit: 2, before });
      assert.ok(page.messages.length <= 2);
      found.push(...page.messages.map(row => row.id));
      before = page.next_before;
      if (before) { assert.ok(!cursors.has(before), 'each page advances'); cursors.add(before); }
    } while (before);

    assert.deepEqual(found, expected);
    assert.equal(new Set(found).size, found.length, 'pages do not duplicate messages');
    assert.equal(fixture.globalPages(), 0);
  });

  test(`${engine}: a sparse filter keeps its continuation inside the selected conversation`, t => {
    const target = message(0, 'sparse', { text: 'Needle found' });
    const candidates = Array.from({ length: 1005 }, (_, index) => message(index + 1, 'sparse', { speaker: 'person' }));
    const unrelated = message(2000, 'other', { text: 'Needle outside the conversation' });
    const fixture = scenario(t, engine, [target, ...candidates, unrelated]);
    const first = fixture.owner.read({ conversation_id: 'sparse', speaker: 'ai', limit: 5 });
    assert.deepEqual(first.messages, []);
    assert.equal(first.looked_through, 1000, 'secondary filters still have bounded work');
    assert.ok(first.next_before, 'an unfinished filtered read must not claim exhaustion');
    const next = fixture.owner.read({ conversation_id: 'sparse', speaker: 'ai', limit: 5, before: first.next_before });
    assert.deepEqual(next.messages.map(row => row.id), [target.id]);
    assert.equal(next.next_before, null);
    assert.equal(next.looked_through, 6);
    assert.equal(fixture.globalPages(), 0);
  });

  test(`${engine}: a missing or removed conversation is exhausted without scanning unrelated app history`, t => {
    const removed = message(0, 'removed');
    const unrelated = Array.from({ length: 1100 }, (_, index) => message(index + 1, `other-${index}`));
    const fixture = scenario(t, engine, [removed, ...unrelated]);
    fixture.eeaf.write([{ id: removed.id, type: 'message', value: null }], { actor: { by: 'test' } });
    for (const conversation_id of ['missing', 'removed']) {
      const result = fixture.owner.read({ conversation_id, limit: 100 });
      assert.deepEqual(result.messages, []);
      assert.equal(result.next_before, null, 'an empty conversation has no unrelated continuation');
      assert.equal(result.looked_through, 0);
    }
    assert.equal(fixture.globalPages(), 0);
  });
}
