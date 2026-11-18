import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  applyBoardPartitionDecision, commitPartitionedBoardCommand, prepareBoardPartition,
  readBoardPartition, releaseBoardPartition, reserveBoardCapacity, commitBoardCapacity, releaseBoardCapacity, seedBoardCapacity,
  setupBoardCapacity, setupBoardPartitions,
} from '../src/space-board-partitions.mjs';

function database() {
  const db = new DatabaseSync(':memory:');
  const sql = { exec(query, ...binds) {
    const statement = db.prepare(query);
    const result = /^\s*(select|pragma|with)\b/i.test(query) ? statement.all(...binds) : (statement.run(...binds), []);
    return { toArray: () => result.map(row => ({ ...row })) };
  } };
  sql.exec('CREATE TABLE space_board_records (space_id TEXT NOT NULL,address TEXT NOT NULL,value TEXT NOT NULL,changed_at TEXT NOT NULL,changed_by TEXT NOT NULL,PRIMARY KEY(space_id,address))');
  setupBoardPartitions(sql);
  return { db, sql };
}

function rig({ failCommit = null } = {}) {
  const coordinator = database();
  const owners = new Map([[0, database()], [1, database()]]);
  let failure = failCommit;
  const participants = new Map([...owners].map(([shard, { sql }]) => [shard, {
    async prepare(input) { return prepareBoardPartition(sql, input); },
    async commit(input) {
      if (failure === shard) { failure = null; throw new Error(`commit reply failed on shard ${shard}`); }
      return applyBoardPartitionDecision(sql, { ...input, decision: 'commit' });
    },
    async abort(input) { return applyBoardPartitionDecision(sql, { ...input, decision: 'abort' }); },
    async release(input) { return releaseBoardPartition(sql, input); },
  }]));
  const commit = (changes, requestKey, id = null) => commitPartitionedBoardCommand(coordinator.sql, {
    space_id: 'one-company-space', coordinator_address: 'network-command-owner', relay: 'relay:ana', request_key: requestKey,
    identity: JSON.stringify(changes), changes,
    shardForAddress: address => address.startsWith('left:') ? 0 : 1,
    participants, commandId: id ?? undefined,
    transactionSync: fn => {
      coordinator.db.exec('SAVEPOINT board_partition_command');
      try { const result = fn(); coordinator.db.exec('RELEASE board_partition_command'); return result; }
      catch (error) { coordinator.db.exec('ROLLBACK TO board_partition_command'); coordinator.db.exec('RELEASE board_partition_command'); throw error; }
    },
  });
  return { coordinator, owners, participants, commit };
}

test('a held operation in one Space shard does not block unrelated same-Space work', async () => {
  const { owners, participants, commit } = rig();
  let releaseA;
  let startedA;
  const gate = new Promise(resolve => { releaseA = resolve; });
  const began = new Promise(resolve => { startedA = resolve; });
  const participant = owners.get(0).sql;
  const originalPrepare = prepareBoardPartition;
  const ownerA = participants.get(0);
  participants.set(0, {
    ...ownerA,
    async prepare(input) { const result = originalPrepare(participant, input); startedA(); await gate; return result; },
  });
  const first = commit([{ address: 'left:held', value: { title: 'Held' } }], 'request-a', 'cmd-a');
  await began;
  const second = await commit([{ address: 'right:free', value: { title: 'Free' } }], 'request-b', 'cmd-b');
  assert.equal(second.records[0].address, 'right:free');
  releaseA();
  await first;
});

test('same-record prepares conflict while disjoint addresses can proceed', async () => {
  const { owners, participants, commit } = rig();
  let finishPrepare;
  let announcePrepare;
  const gate = new Promise(resolve => { finishPrepare = resolve; });
  const began = new Promise(resolve => { announcePrepare = resolve; });
  const shard = owners.get(0).sql;
  const original = participants.get(0);
  participants.set(0, { ...original, async prepare(input) { const value = prepareBoardPartition(shard, input); announcePrepare(); await gate; return value; } });
  const first = commit([{ address: 'left:same', value: { n: 1 } }], 'first', 'same-a');
  await began;
  await assert.rejects(commit([{ address: 'left:same', value: { n: 2 } }], 'second', 'same-b'), /prepared command/);
  finishPrepare();
  await first;
  const rows = await readBoardPartition(shard, { space_id: 'one-company-space', commandState: async () => 'completed' });
  assert.deepEqual(rows.map(row => row.value), [{ n: 1 }]);
});

test('a failed participant leaves a multi-shard command unreadable until roll-forward completes', async () => {
  const { owners, participants, commit } = rig();
  let fail = true;
  const shard1 = participants.get(1);
  participants.set(1, { ...shard1, async commit(input) { if (fail) { fail = false; throw new Error('lost participant reply'); } return shard1.commit(input); } });
  const changes = [
    { address: 'left:a', value: { n: 'A' } },
    { address: 'right:b', value: { n: 'B' } },
  ];
  await assert.rejects(commit(changes, 'atomic', 'cmd-atomic'), /lost participant reply/);
  const shard0Sql = owners.get(0).sql;
  await assert.rejects(readBoardPartition(shard0Sql, {
    space_id: 'one-company-space', commandState: async () => 'committing',
  }), error => error.code === 'BOARD_PARTITION_SETTLING');
  const recovered = await commit(changes, 'atomic', 'unused-retry-id');
  assert.deepEqual(recovered.records.map(record => record.address), ['left:a', 'right:b']);
  assert.deepEqual((await readBoardPartition(shard0Sql, {
    space_id: 'one-company-space', commandState: async () => 'completed',
  })).map(row => row.address), ['left:a']);
});

test('a policy fence durably aborts a preparing command before it can publish committing', async () => {
  const { coordinator, owners, participants, commit } = rig();
  let releasePrepare;
  let announcePrepare;
  const gate = new Promise(resolve => { releasePrepare = resolve; });
  const began = new Promise(resolve => { announcePrepare = resolve; });
  const participant = participants.get(0);
  participants.set(0, {
    ...participant,
    async prepare(input) {
      const prepared = await participant.prepare(input);
      coordinator.sql.exec("UPDATE space_board_partition_commands SET state='aborted',error='policy-fenced' WHERE command_id=? AND state='preparing'", input.command_id);
      announcePrepare();
      await gate;
      return prepared;
    },
  });
  const command = commit([{ address: 'left:fenced', value: { title: 'must not land' } }], 'fence-race', 'cmd-fenced');
  await began;
  releasePrepare();
  await assert.rejects(command, /durably aborted by a policy fence/);
  assert.equal(coordinator.sql.exec('SELECT state FROM space_board_partition_commands WHERE command_id=?', 'cmd-fenced').toArray()[0].state, 'aborted');
  assert.equal(owners.get(0).sql.exec('SELECT COUNT(*) AS n FROM space_board_records').toArray()[0].n, 0);
  assert.equal(owners.get(0).sql.exec('SELECT COUNT(*) AS n FROM space_board_partition_locks').toArray()[0].n, 0);
});

test('a lost prepare reply aborts every planned participant using the durable abort decision', async () => {
  const { coordinator, owners, participants, commit } = rig();
  const original = participants.get(0);
  participants.set(0, {
    ...original,
    async prepare(input) { await original.prepare(input); throw new Error('prepare reply lost after durable write'); },
  });
  const changes = [
    { address: 'left:prepared', value: { title: 'discard' } },
    { address: 'right:never-reached', value: { title: 'also discard' } },
  ];
  await assert.rejects(commit(changes, 'prepare-loss', 'cmd-prepare-loss'), /prepare reply lost/);
  assert.equal(coordinator.sql.exec('SELECT state FROM space_board_partition_commands WHERE command_id=?', 'cmd-prepare-loss').toArray()[0].state, 'aborted');
  for (const { sql } of owners.values()) {
    assert.equal(sql.exec('SELECT COUNT(*) AS n FROM space_board_partition_locks').toArray()[0].n, 0);
    assert.equal(sql.exec('SELECT COUNT(*) AS n FROM space_board_partition_prepares').toArray()[0].n, 0);
  }
});

test('successful request keys replay exact committed rows and reject changed input', async () => {
  const { commit } = rig();
  const changes = [{ address: 'right:task', value: { title: 'Ship' } }];
  const first = await commit(changes, 'key-1', 'cmd-replay');
  const replay = await commit(changes, 'key-1', 'ignored-command-id');
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.records, first.records);
  await assert.rejects(commit([{ address: 'right:task', value: { title: 'Different' } }], 'key-1'), /already names different changes/);
});

test('the narrow capacity owner reserves only distinct creates and enforces the Space-wide limit', () => {
  const { sql } = database();
  setupBoardCapacity(sql);
  seedBoardCapacity(sql, { space_id: 'one-company-space', addresses: ['left:a', 'right:b'], max_records: 3 });
  assert.deepEqual(reserveBoardCapacity(sql, { space_id: 'one-company-space', command_id: 'create-c', addresses: ['right:b', 'new:c'], max_records: 3 }), { reserved: 1, existing: 1 });
  assert.throws(() => reserveBoardCapacity(sql, { space_id: 'one-company-space', command_id: 'create-d', addresses: ['new:d'], max_records: 3 }), /board is full/);
  commitBoardCapacity(sql, { space_id: 'one-company-space', command_id: 'create-c' });
  assert.throws(() => reserveBoardCapacity(sql, { space_id: 'one-company-space', command_id: 'create-e', addresses: ['new:e'], max_records: 3 }), /board is full/);
});

test('same-address capacity claims survive one contender releasing or committing', () => {
  const { sql } = database();
  setupBoardCapacity(sql);
  reserveBoardCapacity(sql, { space_id: 'one-company-space', command_id: 'first', addresses: ['shared:record'] });
  assert.deepEqual(reserveBoardCapacity(sql, { space_id: 'one-company-space', command_id: 'second', addresses: ['shared:record'] }), { reserved: 0, existing: 1 });
  assert.deepEqual(releaseBoardCapacity(sql, { space_id: 'one-company-space', command_id: 'first' }), { released: true, command_id: 'first', addresses: 1 });
  assert.equal(sql.exec('SELECT state FROM space_board_capacity_addresses WHERE space_id=? AND address=?', 'one-company-space', 'shared:record').toArray()[0].state, 'reserved');
  commitBoardCapacity(sql, { space_id: 'one-company-space', command_id: 'second' });
  assert.equal(sql.exec('SELECT state FROM space_board_capacity_addresses WHERE space_id=? AND address=?', 'one-company-space', 'shared:record').toArray()[0].state, 'committed');
  assert.equal(sql.exec('SELECT COUNT(*) AS n FROM space_board_capacity_claims WHERE space_id=? AND address=?', 'one-company-space', 'shared:record').toArray()[0].n, 0);
});
