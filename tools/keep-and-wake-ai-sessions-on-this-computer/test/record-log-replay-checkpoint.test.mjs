import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';

// A cold owner uses the same durable checkpoint for replay metadata and its frontier.
// Historical numeric checkpoints and current objects must keep identical records,
// including writes after the checkpoint; metadata reads must not amplify on open.
for (const shape of ['current', 'numeric']) test(`cold replay captures one ${shape} checkpoint and retains its tail`, () => {
  const host = sqliteHost(':memory:');
  try {
    const store = recordLogStore(host.sql, { transaction: host.transaction });
    store.write([{ id: 'note:kept', type: 'note', value: { text: 'Before the checkpoint' } }]);
    store.checkpoint();
    if (shape === 'numeric') {
      const held = JSON.parse(host.sql.exec("SELECT value FROM record_keys_meta WHERE key = 'covered'").toArray()[0].value);
      host.sql.exec("UPDATE record_keys_meta SET value = ? WHERE key = 'covered'", JSON.stringify(held.at));
    }
    store.write([{ id: 'note:tail', type: 'note', value: { text: 'After the checkpoint' } }]);
    let checkpointReads = 0;
    const sql = { exec(query, ...params) {
      if (query === 'SELECT value FROM record_keys_meta WHERE key = ?' && params[0] === 'covered') checkpointReads += 1;
      return host.sql.exec(query, ...params);
    } };
    const reopened = recordLogStore(sql, { transaction: host.transaction });
    // The separate carried-index initializer reads its proof before replay.
    assert.equal(checkpointReads, 2, 'one carried-index proof plus one replay snapshot, independent of metadata size');
    assert.deepEqual(reopened.read('note:kept'), { text: 'Before the checkpoint' });
    assert.deepEqual(reopened.read('note:tail'), { text: 'After the checkpoint' });
    assert.equal(reopened.read('note:missing'), null);
  } finally { host.db.close(); }
});
