// Send the builder's result through the run-scoped records door. The caller receives only a
// result object; payloads, plans, credentials and status never go to a host file.
import { randomUUID } from 'node:crypto';

const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

function commandsOf(payload, type, prefix) {
  if (!payload || !Array.isArray(payload.commands)) throw new Error('Give the records builder result with commands.');
  if (typeof type !== 'string' || !type || typeof prefix !== 'string' || !prefix) {
    throw new Error('Give the exact target_type and target_prefix this writer row was granted.');
  }
  const commands = [];
  let outOfScope = 0;
  for (const [commandIndex, command] of payload.commands.entries()) {
    const sourceBatch = command?.input?.records;
    if (!Array.isArray(sourceBatch) || sourceBatch.length === 0 || sourceBatch.length > 64) {
      throw new Error(`Builder command ${commandIndex + 1} must hold 1 to 64 records.`);
    }
    for (const [recordIndex, record] of sourceBatch.entries()) {
      if (!record || typeof record.id !== 'string' || !record.id || typeof record.type !== 'string' || !record.type
        || !Object.hasOwn(record, 'value')) {
        throw new Error(`Builder command ${commandIndex + 1} record ${recordIndex + 1} needs id, type and value.`);
      }
      if (record.type !== type || !record.id.startsWith(prefix)) outOfScope += 1;
    }
    const batch = sourceBatch.filter(record => record.type === type && record.id.startsWith(prefix));
    if (batch.length) {
      commands.push(batch);
    }
  }
  return { commands, outOfScope };
}

async function heldRecords(door, type, prefix) {
  const held = new Map();
  for await (const record of door.list({ type, prefix })) held.set(record.id, record);
  return held;
}

function equalRecord(left, right) {
  return left?.type === right.type && canonical(left.value) === canonical(right.value);
}

/** Write builder output with this run's capability, preserving existing rows when requested. */
export async function sendBuiltRecordWrite(input, { door }) {
  if (!input || !input.payload) throw new Error('Give the records builder result as payload.');
  if (input.keep_held !== undefined && typeof input.keep_held !== 'boolean') throw new Error('keep_held is true or false.');
  const { commands: sourceCommands, outOfScope } = commandsOf(input.payload, input.target_type, input.target_prefix);
  const all = sourceCommands.flat();
  const before = await heldRecords(door, input.target_type, input.target_prefix);
  const pendingCommands = sourceCommands.map(batch => batch.filter(record => {
    const held = before.get(record.id);
    if (input.keep_held && held) return false;
    if (record.value === null) return Boolean(held);
    return !held || !equalRecord(held, record);
  })).filter(batch => batch.length > 0);
  const pending = pendingCommands.flat();
  const runKey = `built-records-${randomUUID()}`;
  let written = 0;
  let commands = 0;
  for (const batch of pendingCommands) {
    const command = ++commands;
    try {
      await door.write(batch, { key: `${runKey}:${command}` });
      written += batch.length;
    } catch (error) {
      // An unknown result may have written the batch. Read it back before describing the stop.
      let reconciled = false;
      try {
        const after = await heldRecords(door, input.target_type, input.target_prefix);
        reconciled = batch.every(record => equalRecord(after.get(record.id), record));
      } catch {}
      if (reconciled) { written += batch.length; continue; }
      const readback = await readbackRecords(door, all, input.target_type, input.target_prefix);
      return {
        state: 'stopped_on_refusal', to_write: pending.length, commands, written, out_of_scope: outOfScope,
        last_refusal: { command, records: batch.length, reason: error?.message ?? 'The records door refused the write.' },
        readback,
      };
    }
  }
  const readback = await readbackRecords(door, all, input.target_type, input.target_prefix);
  return { state: 'all_written', to_write: pending.length, commands, written, out_of_scope: outOfScope, readback };
}

async function readbackRecords(door, records, type, prefix) {
  const held = await heldRecords(door, type, prefix);
  const out = {};
  for (const record of records) {
    const entry = out[record.type] ??= { payload: 0, held: 0, equal: 0, missing: [], differing: [] };
    entry.payload += 1;
    const current = held.get(record.id);
    if (record.value === null) {
      if (!current) entry.equal += 1;
      else { entry.held += 1; entry.differing.push(record.id); }
      continue;
    }
    if (!current) { entry.missing.push(record.id); continue; }
    entry.held += 1;
    if (equalRecord(current, record)) entry.equal += 1;
    else entry.differing.push(record.id);
  }
  return out;
}
