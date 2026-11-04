// Durable participant protocol for stable, independently addressed BoardRoom shards.
// The coordinator owns request identity and the commit decision; shard participants
// hold address locks until every participant has applied that decision.
import { mergeBoardValue } from '../../../keep-a-space-board/src/board-record-values.mjs';

const MAX_ADDRESS = 400;
const MAX_VALUE_BYTES = 256 * 1024;
const MAX_CHANGES = 200;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const rows = (sql, query, ...binds) => sql.exec(query, ...binds).toArray();
const publicValue = (address, value) => address.startsWith('shared:') && isObject(value) && value.__shared_record === true
  ? { kind: 'shared-record', revision: value.revision, deleted: value.deleted, ...(value.deleted ? {} : { value: value.value }) }
  : value;

export const setupBoardPartitions = sql => {
  sql.exec('CREATE TABLE IF NOT EXISTS space_board_command_directory(space_id TEXT NOT NULL,command_id TEXT NOT NULL,coordinator_address TEXT NOT NULL,relay TEXT NOT NULL,PRIMARY KEY(space_id,command_id))');
  sql.exec('CREATE TABLE IF NOT EXISTS space_board_partition_locks (space_id TEXT NOT NULL, address TEXT NOT NULL, command_id TEXT NOT NULL, coordinator_address TEXT NOT NULL DEFAULT \'\', PRIMARY KEY(space_id,address))');
  sql.exec('CREATE INDEX IF NOT EXISTS space_board_partition_locks_command ON space_board_partition_locks(command_id)');
  sql.exec('CREATE TABLE IF NOT EXISTS space_board_partition_prepares (command_id TEXT NOT NULL, space_id TEXT NOT NULL, address TEXT NOT NULL, old_value TEXT, new_value TEXT NOT NULL, changed_at TEXT NOT NULL, changed_by TEXT NOT NULL, coordinator_address TEXT NOT NULL DEFAULT \'\', PRIMARY KEY(command_id,address))');
  sql.exec('CREATE TABLE IF NOT EXISTS space_board_partition_prepare_manifest (command_id TEXT PRIMARY KEY,space_id TEXT NOT NULL,relay TEXT NOT NULL,identity TEXT NOT NULL,coordinator_address TEXT NOT NULL,addresses TEXT NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS space_board_partition_commands (space_id TEXT NOT NULL, relay TEXT NOT NULL, request_key TEXT NOT NULL, identity TEXT NOT NULL, coordinator_address TEXT NOT NULL, command_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, result TEXT, plan TEXT NOT NULL, error TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(space_id,relay,request_key))');
  sql.exec('CREATE TABLE IF NOT EXISTS space_board_command_participants (command_id TEXT NOT NULL, shard INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY(command_id,shard))');
};

// The bounded board-cardinality invariant remains a narrow owner. Ordinary
// updates never call it; only creation reserves a distinct address. The owner
// serializes at most these <=5000 keys per Space, independent of content writes.
export const setupBoardCapacity = sql => {
  sql.exec('CREATE TABLE IF NOT EXISTS space_board_capacity_addresses (space_id TEXT NOT NULL,address TEXT NOT NULL,state TEXT NOT NULL,command_id TEXT,PRIMARY KEY(space_id,address))');
  sql.exec('CREATE INDEX IF NOT EXISTS space_board_capacity_reservations ON space_board_capacity_addresses(space_id,command_id,state)');
  sql.exec('CREATE TABLE IF NOT EXISTS space_board_capacity_claims (space_id TEXT NOT NULL,address TEXT NOT NULL,command_id TEXT NOT NULL,PRIMARY KEY(space_id,address,command_id))');
  sql.exec('CREATE INDEX IF NOT EXISTS space_board_capacity_claim_commands ON space_board_capacity_claims(space_id,command_id)');
};

export function seedBoardCapacity(sql, { space_id: spaceId, addresses, max_records: maxRecords = 5000 }) {
  if (!Array.isArray(addresses) || addresses.some(address => typeof address !== 'string' || !address)) throw new Error('Board capacity seed needs valid addresses.');
  const unique = [...new Set(addresses)];
  const count = rows(sql, 'SELECT COUNT(*) AS n FROM space_board_capacity_addresses WHERE space_id=?', spaceId)[0]?.n ?? 0;
  if (count + unique.filter(address => !rows(sql, 'SELECT 1 FROM space_board_capacity_addresses WHERE space_id=? AND address=?', spaceId, address).length).length > maxRecords) throw new Error('This board already exceeds its installed record limit.');
  for (const address of unique) sql.exec("INSERT INTO space_board_capacity_addresses(space_id,address,state,command_id) VALUES(?,?,'committed',NULL) ON CONFLICT(space_id,address) DO NOTHING", spaceId, address);
  return { seeded: unique.length };
}

export function reserveBoardCapacity(sql, { space_id: spaceId, command_id: commandId, addresses, max_records: maxRecords = 5000 }) {
  if (typeof spaceId !== 'string' || !spaceId || typeof commandId !== 'string' || !commandId || !Array.isArray(addresses) || addresses.some(address => typeof address !== 'string' || !address)) throw new Error('Board capacity reservation needs valid Space, command, and addresses.');
  const unique = [...new Set(addresses)];
  const missing = unique.filter(address => !rows(sql, 'SELECT 1 FROM space_board_capacity_addresses WHERE space_id=? AND address=?', spaceId, address).length);
  const count = rows(sql, 'SELECT COUNT(*) AS n FROM space_board_capacity_addresses WHERE space_id=?', spaceId)[0]?.n ?? 0;
  if (count + missing.length > maxRecords) throw new Error('This board is full.');
  for (const address of missing) sql.exec("INSERT INTO space_board_capacity_addresses(space_id,address,state,command_id) VALUES(?,?,'reserved',?)", spaceId, address, commandId);
  for (const address of unique) sql.exec("INSERT OR IGNORE INTO space_board_capacity_claims(space_id,address,command_id) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM space_board_capacity_addresses WHERE space_id=? AND address=? AND state='reserved')", spaceId, address, commandId, spaceId, address);
  return { reserved: missing.length, existing: unique.length - missing.length };
}

export function commitBoardCapacity(sql, { space_id: spaceId, command_id: commandId }) {
  sql.exec("INSERT OR IGNORE INTO space_board_capacity_claims(space_id,address,command_id) SELECT space_id,address,command_id FROM space_board_capacity_addresses WHERE space_id=? AND command_id=? AND state='reserved'", spaceId, commandId);
  const claimed = rows(sql, 'SELECT address FROM space_board_capacity_claims WHERE space_id=? AND command_id=?', spaceId, commandId).map(row => row.address);
  for (const address of claimed) {
    sql.exec("UPDATE space_board_capacity_addresses SET state='committed',command_id=NULL WHERE space_id=? AND address=? AND state='reserved'", spaceId, address);
    sql.exec('DELETE FROM space_board_capacity_claims WHERE space_id=? AND address=?', spaceId, address);
  }
  return { committed: true, command_id: commandId, addresses: claimed.length };
}

export function releaseBoardCapacity(sql, { space_id: spaceId, command_id: commandId }) {
  sql.exec("INSERT OR IGNORE INTO space_board_capacity_claims(space_id,address,command_id) SELECT space_id,address,command_id FROM space_board_capacity_addresses WHERE space_id=? AND command_id=? AND state='reserved'", spaceId, commandId);
  const claimed = rows(sql, 'SELECT address FROM space_board_capacity_claims WHERE space_id=? AND command_id=?', spaceId, commandId).map(row => row.address);
  sql.exec('DELETE FROM space_board_capacity_claims WHERE space_id=? AND command_id=?', spaceId, commandId);
  for (const address of claimed) sql.exec("DELETE FROM space_board_capacity_addresses WHERE space_id=? AND address=? AND state='reserved' AND NOT EXISTS (SELECT 1 FROM space_board_capacity_claims WHERE space_id=? AND address=?)", spaceId, address, spaceId, address);
  return { released: true, command_id: commandId, addresses: claimed.length };
}

export function eraseBoardCapacity(sql, { space_id: spaceId }) {
  sql.exec('DELETE FROM space_board_capacity_claims WHERE space_id=?', spaceId);
  sql.exec('DELETE FROM space_board_capacity_addresses WHERE space_id=?', spaceId);
  return { erased: true, space_id: spaceId };
}

const recordRow = (sql, spaceId, address) => rows(sql,
  'SELECT value,changed_at,changed_by FROM space_board_records WHERE space_id = ? AND address = ?', spaceId, address)[0];

export function assertBoardPartitionUnlocked(sql, spaceId, address) {
  const lock = rows(sql, 'SELECT command_id FROM space_board_partition_locks WHERE space_id = ? AND address = ?', spaceId, address)[0];
  if (lock) {
    const error = new Error('This board record has a prepared command; retry after its decision is visible.');
    error.code = 'BOARD_PARTITION_PREPARED';
    error.command_id = lock.command_id;
    throw error;
  }
}

// Called on the addressed shard. It performs no visible record writes: all values
// and merge results are durable in the prepare table while the address locks fence
// competing CAS/commit operations.
export function prepareBoardPartition(sql, { command_id: commandId, coordinator_address: coordinatorAddress = '', space_id: spaceId, relay, identity = null, changes }) {
  if (typeof commandId !== 'string' || !commandId || typeof coordinatorAddress !== 'string' || !coordinatorAddress || typeof spaceId !== 'string' || !spaceId || typeof relay !== 'string' || !relay) throw new Error('A board partition prepare needs its command, coordinator, Space, and relay.');
  if (!Array.isArray(changes) || !changes.length || changes.length > MAX_CHANGES) throw new Error(`A board partition prepare needs 1 to ${MAX_CHANGES} changes.`);
  const prepareIdentity = identity ?? JSON.stringify(changes);
  const manifest = rows(sql, 'SELECT * FROM space_board_partition_prepare_manifest WHERE command_id=?', commandId)[0];
  const requestedAddresses = changes.map(change => String(change?.address ?? '')).sort();
  if (manifest) {
    if (manifest.space_id !== spaceId || manifest.relay !== relay || manifest.identity !== prepareIdentity || manifest.coordinator_address !== coordinatorAddress || manifest.addresses !== JSON.stringify(requestedAddresses)) throw new Error('A board command id already names different prepared changes.');
    const saved = rows(sql, 'SELECT address,old_value,new_value,changed_at,changed_by FROM space_board_partition_prepares WHERE command_id = ? ORDER BY address', commandId);
    return { prepared: true, command_id: commandId, created:saved.filter(row=>row.old_value===null).map(row=>row.address), records: saved.map(row => ({ address: row.address, value: JSON.parse(row.new_value) })) };
  }
  const seen = new Set();
  const proposed = [];
  for (const change of changes) {
    const address = String(change?.address ?? '');
    if (!address || address.length > MAX_ADDRESS) throw new Error('Each board change needs an address.');
    if (change.value === undefined) throw new Error(`The board change to ${address} has no value.`);
    if (seen.has(address)) throw new Error(`A board command may change ${address} only once.`);
    seen.add(address);
    assertBoardPartitionUnlocked(sql, spaceId, address);
    const currentRow = recordRow(sql, spaceId, address);
    const current = currentRow ? JSON.parse(currentRow.value) : undefined;
    if (address.startsWith('shared:') || (isObject(current) && current.__shared_record === true)) throw new Error('This shared record must be changed through its revision-checked record route.');
    const value = currentRow ? mergeBoardValue(change.base ?? undefined, change.value, current) : change.value;
    if (bytes(value) > MAX_VALUE_BYTES) throw new Error(`The board record ${address} is too big.`);
    proposed.push({ address, value, old_value: currentRow?.value ?? null, changed_at: new Date().toISOString(), changed_by: relay });
  }
  // A caller wraps this helper in transactionSync. Locks and prepares therefore
  // become visible together or not at all on this participant.
  sql.exec('INSERT INTO space_board_partition_prepare_manifest(command_id,space_id,relay,identity,coordinator_address,addresses) VALUES(?,?,?,?,?,?)', commandId, spaceId, relay, prepareIdentity, coordinatorAddress, JSON.stringify(requestedAddresses));
  for (const row of proposed) {
    sql.exec('INSERT INTO space_board_partition_locks (space_id,address,command_id,coordinator_address) VALUES (?,?,?,?)', spaceId, row.address, commandId, coordinatorAddress);
    sql.exec('INSERT INTO space_board_partition_prepares (command_id,space_id,address,old_value,new_value,changed_at,changed_by,coordinator_address) VALUES (?,?,?,?,?,?,?,?)', commandId, spaceId, row.address, row.old_value, JSON.stringify(row.value), row.changed_at, row.changed_by, coordinatorAddress);
  }
  return { prepared: true, command_id: commandId, created:proposed.filter(row=>row.old_value===null).map(row=>row.address), records: proposed.map(({ address, value }) => ({ address, value })) };
}

// `commit` applies the rows but deliberately retains locks. The coordinator marks
// the command completed only after every participant has applied; reads reject
// locked rows until then, so a failed participant can never expose a partial batch.
export function applyBoardPartitionDecision(sql, { command_id: commandId, decision }) {
  if (decision !== 'commit' && decision !== 'abort') throw new Error('A board participant needs a commit or abort decision.');
  const prepared = rows(sql, 'SELECT * FROM space_board_partition_prepares WHERE command_id = ? ORDER BY address', commandId);
  if (!prepared.length) return { applied: true, command_id: commandId, rows: 0 };
  const result = prepared.map(row => ({ address: row.address, value: JSON.parse(row.new_value), changed_at: row.changed_at, changed_by: row.changed_by }));
  if (decision === 'commit') {
    for (const row of prepared) sql.exec('INSERT INTO space_board_records (space_id,address,value,changed_at,changed_by) VALUES (?,?,?,?,?) ON CONFLICT(space_id,address) DO UPDATE SET value=excluded.value,changed_at=excluded.changed_at,changed_by=excluded.changed_by', row.space_id, row.address, row.new_value, row.changed_at, row.changed_by);
  }
  if (decision === 'abort') {
    sql.exec('DELETE FROM space_board_partition_prepares WHERE command_id = ?', commandId);
    sql.exec('DELETE FROM space_board_partition_locks WHERE command_id = ?', commandId);
    sql.exec('DELETE FROM space_board_partition_prepare_manifest WHERE command_id = ?', commandId);
  }
  return { applied: true, command_id: commandId, rows: prepared.length, records: result };
}

export function releaseBoardPartition(sql, { command_id: commandId }) {
  // Only call after the coordinator's durable command state is `completed`.
  sql.exec('DELETE FROM space_board_partition_prepares WHERE command_id = ?', commandId);
  sql.exec('DELETE FROM space_board_partition_locks WHERE command_id = ?', commandId);
  sql.exec('DELETE FROM space_board_partition_prepare_manifest WHERE command_id = ?', commandId);
  return { released: true, command_id: commandId };
}

export async function readBoardPartition(sql, { space_id: spaceId, addresses = null, commandState }) {
  const locks = addresses?.length
    ? addresses.map(address => rows(sql, 'SELECT command_id,coordinator_address FROM space_board_partition_locks WHERE space_id = ? AND address = ?', spaceId, address)[0]).filter(Boolean)
    : rows(sql, 'SELECT DISTINCT command_id,coordinator_address FROM space_board_partition_locks WHERE space_id = ?', spaceId);
  for (const lock of locks) {
    const state = await commandState(lock.command_id, lock.coordinator_address);
    if (state !== 'completed') {
      const error = new Error('A board command is settling across partitions; retry this read.');
      error.code = 'BOARD_PARTITION_SETTLING';
      error.command_id = lock.command_id;
      throw error;
    }
  }
  if (addresses?.length) return addresses.map(address => {
    const row = recordRow(sql, spaceId, address);
    return row ? { address, value: publicValue(address, JSON.parse(row.value)), changed_at: row.changed_at, changed_by: row.changed_by } : null;
  }).filter(Boolean);
  return rows(sql, 'SELECT address,value,changed_at,changed_by FROM space_board_records WHERE space_id = ? ORDER BY address', spaceId)
    .map(row => ({ ...row, value: publicValue(row.address, JSON.parse(row.value)) }));
}

const persistCommand = (sql, value) => sql.exec(
  'INSERT INTO space_board_partition_commands (space_id,relay,request_key,identity,coordinator_address,command_id,state,result,plan,error,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  value.space_id, value.relay, value.request_key, value.identity, value.coordinator_address, value.command_id, value.state,
  value.result, JSON.stringify(value.plan), value.error, new Date().toISOString());

// `participants` is a Map keyed by stable shard index. Each participant provides
// prepare/apply/release/abort RPCs. `capacity.reserve/release` is the narrow board
// cardinality authority; it reserves only absent addresses and never serializes
// ordinary updates. `transactionSync` makes every local command transition durable.
export async function commitPartitionedBoardCommand(sql, {
  space_id: spaceId, coordinator_address: coordinatorAddress, relay, request_key: requestKey, identity, changes, shardForAddress,
  participants, transactionSync = fn => fn(), capacity, commandId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
}) {
  if (!Array.isArray(changes) || !changes.length || changes.length > MAX_CHANGES) throw new Error(`Send 1 to ${MAX_CHANGES} board changes at once.`);
  if (typeof coordinatorAddress !== 'string' || !coordinatorAddress) throw new Error('The board command coordinator address is required.');
  if (typeof shardForAddress !== 'function' || !participants || typeof participants.get !== 'function') throw new Error('The board partition map is unavailable.');
  if (requestKey !== null && requestKey !== undefined && (typeof requestKey !== 'string' || !requestKey || requestKey.length > 512)) throw new Error('A board request key has at most 512 characters.');
  const key = requestKey ?? `@${commandId}`;
  const prior = requestKey ? rows(sql, 'SELECT * FROM space_board_partition_commands WHERE space_id=? AND relay=? AND request_key=?', spaceId, relay, key)[0] : null;
  if (prior) {
    if (prior.identity !== identity) throw new Error('This board request key already names different changes.');
    if (prior.coordinator_address !== coordinatorAddress) throw new Error('This board request key is mounted at another command coordinator.');
    if (prior.state === 'completed') {
      if(prior.result==='null')throw new Error('This board command result was erased and cannot be replayed.');
      const applied = rows(sql, 'SELECT shard FROM space_board_command_participants WHERE command_id=? AND state=?', prior.command_id, 'applied');
      await Promise.all(applied.map(({ shard }) => participants.get(shard)?.release({ command_id: prior.command_id })));
      await capacity?.commit?.({ command_id: prior.command_id, space_id: spaceId, changes, result: JSON.parse(prior.result) });
      return { records: JSON.parse(prior.result), replayed: true, command_id: prior.command_id };
    }
    if (prior.state === 'aborted') throw new Error(prior.error || 'The previous board command was durably aborted.');
    commandId = prior.command_id;
  } else transactionSync(() => persistCommand(sql, {
    space_id: spaceId, relay, request_key: key, identity, coordinator_address: coordinatorAddress, command_id: commandId, state: 'preparing', result: null,
    plan: changes.map(change => ({ shard: shardForAddress(change.address), change })), error: null,
  }));
  const command = rows(sql, 'SELECT * FROM space_board_partition_commands WHERE command_id=?', commandId)[0];
  if (!command || !['preparing', 'committing'].includes(command.state)) throw new Error('The durable board command is in an unknown state.');
  const plan = JSON.parse(command.plan);
  const grouped = new Map();
  for (const item of plan) { if (!grouped.has(item.shard)) grouped.set(item.shard, []); grouped.get(item.shard).push(item.change); }
  if (command.state === 'preparing') {
    try {
      const creates=[];
      for (const [shard, shardChanges] of grouped) {
        const participant = participants.get(shard);
        if (!participant) throw new Error(`Board shard ${shard} is not mounted.`);
        const prepared=await participant.prepare({ command_id: commandId, coordinator_address: coordinatorAddress, space_id: spaceId, relay, changes: shardChanges, identity });
        creates.push(...(prepared.created??[]).map(address=>({address})));
        transactionSync(() => sql.exec('INSERT INTO space_board_command_participants (command_id,shard,state) VALUES (?,?,?) ON CONFLICT(command_id,shard) DO UPDATE SET state=excluded.state', commandId, shard, 'prepared'));
      }
      if(creates.length&&capacity?.reserve)await capacity.reserve({command_id:commandId,space_id:spaceId,relay,changes:creates,plan});
    } catch (error) {
      // Publish the abort before contacting participants. A policy fence can
      // race these awaits; the durable decision tells every participant whether
      // it must discard a prepare or finish an already committed command.
      transactionSync(() => sql.exec("UPDATE space_board_partition_commands SET state='aborted',error=?,updated_at=? WHERE command_id=? AND state='preparing'", String(error?.message ?? error), new Date().toISOString(), commandId));
      const decision = rows(sql, 'SELECT state FROM space_board_partition_commands WHERE command_id=?', commandId)[0]?.state;
      if (decision !== 'aborted') throw error;
      // The failing RPC may have prepared data durably and then lost its reply,
      // so abort every planned participant, not only acknowledged prepares.
      const aborted=await Promise.allSettled([...grouped.keys()].map(shard => participants.get(shard)?.abort({ command_id: commandId })));
      const refused=aborted.find(result=>result.status==='rejected');
      if(refused)throw refused.reason??new Error('A board participant abort did not settle.');
      await capacity?.release?.({ command_id: commandId, space_id: spaceId });
      throw error;
    }
  }
  if (command.state === 'preparing') {
    // Compare-and-set closes the fence race: fence recovery first records
    // `aborted`; only a still-preparing command may publish the commit decision.
    transactionSync(() => sql.exec("UPDATE space_board_partition_commands SET state='committing',updated_at=? WHERE command_id=? AND state='preparing'", new Date().toISOString(), commandId));
    const decision = rows(sql, 'SELECT state FROM space_board_partition_commands WHERE command_id=?', commandId)[0]?.state;
    if (decision === 'aborted') {
      const aborted=await Promise.allSettled([...grouped.keys()].map(shard => participants.get(shard)?.abort({ command_id: commandId })));
      const refused=aborted.find(result=>result.status==='rejected');
      if(refused)throw refused.reason??new Error('A board participant abort did not settle.');
      await capacity?.release?.({ command_id: commandId, space_id: spaceId });
      throw new Error('The board command was durably aborted by a policy fence.');
    }
    if (decision !== 'committing') throw new Error('The board command lost its commit decision race.');
  }
  // Once committing is durable, recovery must roll forward; abort is forbidden.
  const result = [];
  for (const [shard, shardChanges] of grouped) {
    const participant = participants.get(shard);
    const answer = await participant.commit({ command_id: commandId });
    const byAddress = new Map((answer.records ?? []).map(record => [record.address, record]));
    for (const change of shardChanges) { const record = byAddress.get(change.address); if (record) result.push(record); }
    transactionSync(() => sql.exec("UPDATE space_board_command_participants SET state='applied' WHERE command_id=? AND shard=?", commandId, shard));
  }
  await capacity?.commit?.({ command_id: commandId, space_id: spaceId, changes, result });
  transactionSync(() => sql.exec("UPDATE space_board_partition_commands SET state='completed',result=?,updated_at=? WHERE command_id=?", JSON.stringify(result), new Date().toISOString(), commandId));
  await Promise.all([...grouped.keys()].map(shard => participants.get(shard).release({ command_id: commandId })));
  return { records: result, replayed: false, command_id: commandId };
}

export const boardPartitionConstants = Object.freeze({ MAX_ADDRESS, MAX_VALUE_BYTES, MAX_CHANGES });

export const boardPartitionCommandState = (sql, { command_id: commandId }) =>
  rows(sql, 'SELECT state FROM space_board_partition_commands WHERE command_id=?', commandId)[0]?.state ?? 'missing';
