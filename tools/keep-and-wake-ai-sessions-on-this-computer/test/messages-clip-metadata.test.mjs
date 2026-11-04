import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sqliteHost } from '../src/local-store.mjs';
import { openRecords } from '../src/record-engine.mjs';
import { eeafStore } from '../parts/eeaf/do-work/eeaf-sqlite-store.mjs';
import { messages } from '../src/messages.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

for (const engine of ['log', 'eeaf']) {
  test(`${engine}: clips retain newest-turn order and refresh after edit/removal without reading message bodies`, () => {
    const host = sqliteHost(':memory:');
    if (engine === 'eeaf') eeafStore(host.sql, { transaction: host.transaction, hash }).write([{ id: 'message:seed', type: 'message', value: {
      app: 'Chat', speaker: 'person', at: '2026-10-01T00:00:00Z', text: 'A named turn',
    } }]);
    const eeaf = openRecords(host.sql, { transaction: host.transaction, hash });
    assert.equal(eeaf.engine(), engine === 'log' ? 'record-log' : 'eeaf');
    eeaf.write([
      { id: 'message:older', type: 'message', value: { app: 'Listening', speaker: 'Someone (voice-1)', at: '2026-10-10T09:00:00Z', text: 'Older words',
        about: [{ kind: 'pursuit', id: 'pursuit:one' }, { kind: 'file', id: 'file:first' }, { kind: 'file', id: 'file:second' }],
        attachments: [{ name: 'Unrelated attachment', data: 'x'.repeat(10000) }],
      } },
      { id: 'message:newer', type: 'message', value: { app: 'Listening', speaker: 'Someone (voice-1)', at: '2026-10-10T09:01:00Z', text: 'Newest words' } },
    ]);
    const read = eeaf.read.bind(eeaf), memberFields = eeaf.memberFields.bind(eeaf);
    const metadataReads = [];
    eeaf.read = id => {
      if (id.startsWith('message:')) throw new Error('Voice clip discovery must not hydrate a turn');
      return read(id);
    };
    eeaf.memberFields = (id, field, names, ...rest) => {
      metadataReads.push({ id, field, names });
      return memberFields(id, field, names, ...rest);
    };
    const memberFieldsMany = eeaf.memberFieldsMany.bind(eeaf);
    eeaf.memberFieldsMany = (ids, field, names, ...rest) => {
      metadataReads.push(...ids.map(id => ({ id, field, names })));
      return memberFieldsMany(ids, field, names, ...rest);
    };
    const kept = messages(eeaf);
    const options = { pattern: '^Someone', session_gap_seconds: 1800, most: 1 };
    const [row] = kept.unnamedSpeakers(options);
    assert.equal(row.clip, 'file:first');
    assert.equal(row.last_words, 'Newest words');
    assert.equal(row.turns, 2);
    assert.deepEqual(metadataReads.map(r => r.id), ['message:newer', 'message:older']);
    assert.ok(metadataReads.every(r => r.field === 'about' && JSON.stringify(r.names) === '["kind","id"]'));
    const count = metadataReads.length;
    assert.deepEqual(kept.unnamedSpeakers(options), [row]);
    assert.equal(metadataReads.length, count, 'unchanged memo reads no metadata again');
    eeaf.write([{ id: 'message:older', type: 'message', value: { ...read('message:older'), about: [{ kind: 'file', id: 'file:changed' }] } }]);
    assert.equal(kept.unnamedSpeakers(options)[0].clip, 'file:changed');
    eeaf.write([{ id: 'message:older', value: null }]);
    const [remaining] = kept.unnamedSpeakers(options);
    assert.equal(remaining.turns, 1);
    assert.equal(remaining.clip, undefined);
    assert.equal(remaining.last_words, 'Newest words');
  });
}
