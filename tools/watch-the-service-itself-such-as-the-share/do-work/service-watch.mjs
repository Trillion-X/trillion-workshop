// Account-owned lifecycle. The records owner supplies durable CAS and receipt identity;
// the generic wake owner supplies the clock, current rights and cancellation.
import { makeHashCodeHexFromJson as identity } from '../../content-identity/read-data/identity.mjs';
const TYPE = 'service-watch';
const idOf = id => { if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new TypeError('Choose a watch_id.'); return `${TYPE}:${id}`; };
const fail = (reason, more = {}) => ({ state: 'unresolved', reason, ...more });
const instant = value => { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError('The native task must carry its start time.'); return new Date(value).toISOString(); };
const scopeOf = value => ({ connection_id: value.connection_id, since: value.since, until: value.until });
const valid = value => value && /^service_connection:cloudflare(?::[^:\s]+)?$/.test(value.connection_id ?? '')
  && ['since', 'until'].every(key => typeof value[key] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value[key]) && Number.isFinite(Date.parse(value[key])) && new Date(value[key]).toISOString().slice(0,10) === value[key])
  && value.since <= value.until && Number.isSafeInteger(value.every_minutes) && value.every_minutes >= 5 && value.every_minutes <= 10080;
const expectedOf = record => record ? { type: record.type, ...(record.identity ? { identity: record.identity } : { value: record.value }) } : null;
// Only compare this package's effect here. The actual admitted root (including
// Native's cause stamp) is read back and carried into every later CAS.
const ownValue = value => { const { _wake_cause, ...own } = value; return own; };
const sameEffect = (actual, wanted) => actual && identity(ownValue(actual.value)) === identity(ownValue(wanted));
function writeOf(id, value, prior) { return [{ id, type: TYPE, value, expected: expectedOf(prior) }]; }
async function keep(door, records, key) {
  // A refusal/unknown is never retried with a fresh key or a reconstructed body.
  try { await door.write(records, { key }); return null; }
  catch (error) {
    const original = { request_key: key, operation: 'records:write', input: { records } };
    if (error.code === 'original_command_conflict') return fail('conflict', { original });
    // This is a protected read of the exact original, never another write. An
    // unavailable, erased or currently refused result remains unresolved.
    try { await door.result(original, { key: `${key}:result` }); return null; } catch {}
    return fail('write_unresolved', { original });
  }
}
function finalOf(id, pending) {
  const { in_flight, ...before } = pending.value;
  const value = { ...before, revision: before.revision + 1, latest: in_flight.candidate,
    next_due_at: in_flight.next_due_at };
  return { records: writeOf(id, value, pending), key: in_flight.final_key };
}
async function finish(door, id, pending, { recover = false } = {}) {
  const command = finalOf(id, pending);
  if (recover) {
    const original = { request_key: command.key, operation: 'records:write', input: { records: command.records } };
    // A fresh wake has another capability/cause. Its original-context adapter
    // must prove this receipt; repeating a write here would stamp a new cause.
    try { await door.result(original); }
    catch { return fail('original_context_unavailable', { original, parent_request_key: pending.value.in_flight.run_key }); }
  } else {
    const problem = await keep(door, command.records, command.key);
    if (problem) return problem;
  }
  const readback = await door.readRecord(TYPE, id);
  if (!readback || identity(readback.value) !== identity(command.records[0].value)) return fail('readback_changed');
  return { state: 'saved', watch: readback.value, expected: expectedOf(readback) };
}

// stdin is composed by the descriptor from input and the native task separately.
export async function serviceWatch({ input = {}, task } = {}, { door } = {}) {
  if (!task || typeof task.request_key !== 'string' || !task.request_key) throw new TypeError('The native task must carry its original request key.');
  const at = instant(task.started_at), key = task.request_key;
  const operation = input.operation ?? 'wake';
  if (operation === 'read') return readSavedServiceWatches(input, { door });
  if (operation === 'configure') {
    const id = idOf(input.watch_id);
    if (!valid(input)) throw new TypeError('Choose a connection, real inclusive UTC dates and an interval of 5 to 10080 minutes.');
    const prior = await door.readRecord(TYPE, id);
    if (identity(expectedOf(prior)) !== identity(input.expected ?? null)) return fail('conflict');
    if (prior?.value?.in_flight) return fail('in_flight');
    const value = { watch_id: input.watch_id, ...scopeOf(input), every_minutes: input.every_minutes,
      enabled: true, revision: (prior?.value?.revision ?? 0) + 1, next_due_at: at, latest: prior?.value?.latest ?? null };
    const problem = await keep(door, writeOf(id, value, prior), `${key}:configure`);
    if (problem) return problem;
    const readback = await door.readRecord(TYPE, id);
    return sameEffect(readback, value) ? { state: 'configured', watch: readback.value, expected: expectedOf(readback) } : fail('readback_changed');
  }
  if (operation === 'delete') {
    const id = idOf(input.watch_id), prior = await door.readRecord(TYPE, id);
    if (!prior || identity(expectedOf(prior)) !== identity(input.expected ?? null)) return fail('conflict');
    // Unresolved original calls remain in the same root until their existing
    // owner can prove their outcome; deleting that custody would hide unknown work.
    if (prior.value.in_flight) return fail('in_flight', { watch_id: input.watch_id });
    const problem = await keep(door, writeOf(id, null, prior), `${key}:delete`);
    if (problem) return problem;
    return await door.readRecord(TYPE, id) === null ? { state: 'deleted', watch_id: input.watch_id } : fail('readback_changed');
  }
  if (operation === 'pause') {
    const id = idOf(input.watch_id), prior = await door.readRecord(TYPE, id);
    if (!prior || identity(expectedOf(prior)) !== identity(input.expected ?? null)) return fail('conflict');
    // Keep the original in-flight command, even when disabled. No provider request is made.
    const value = { ...prior.value, enabled: false, revision: prior.value.revision + 1 };
    const problem = await keep(door, writeOf(id, value, prior), `${key}:pause`);
    if (problem) return problem;
    const readback = await door.readRecord(TYPE, id);
    return sameEffect(readback, value) ? { state: 'paused', watch: readback.value, expected: expectedOf(readback) } : fail('readback_changed');
  }
  if (operation !== 'wake') throw new TypeError('Choose configure, pause, delete, read or wake.');
  // The oldest due watch goes first, so a short interval cannot starve its siblings.
  // This scans only this account's declared service-watch kind, never another store.
  const rows = [], unresolved = [];
  for await (const row of door.list({ type: TYPE, prefix: `${TYPE}:` })) rows.push(row);
  rows.sort((a, b) => Date.parse(a.value?.next_due_at) - Date.parse(b.value?.next_due_at));
  for (const row of rows) {
    if (!row.value?.enabled) continue;
    const id = idOf(row.value.watch_id), prior = await door.readRecord(TYPE, id);
    if (!prior?.value?.enabled) continue;
    const watch = prior.value;
    if (!valid(watch)) { unresolved.push(fail('invalid_saved_scope', { watch_id: watch.watch_id })); continue; }
    if (watch.in_flight?.phase === 'candidate') {
      const recovered = await finish(door, id, prior, { recover: true });
      if (recovered.state === 'saved') return recovered;
      unresolved.push(recovered); continue;
    }
    if (watch.in_flight) { unresolved.push(fail('candidate_unresolved', { watch_id: watch.watch_id, run_key: watch.in_flight.run_key })); continue; }
    if (Date.parse(watch.next_due_at) > Date.parse(at)) continue;
    const producer = { parent_request_key: key, tool: 'tool:read-service-usage', input: scopeOf(watch), request_key: `${key}:reading` };
    const claimed = { ...watch, in_flight: { phase: 'claimed', run_key: key, at, producer } };
    let problem = await keep(door, writeOf(id, claimed, prior), `${key}:claim`);
    if (problem) return problem;
    const claimedRoot = await door.readRecord(TYPE, id);
    if (!sameEffect(claimedRoot, claimed)) return fail('readback_changed');
    // The nested run is checked against this wake's CURRENT grant and selected connection.
    let reading;
    try { reading = await door.run(producer.tool, producer.input, { key: producer.request_key }); }
    catch { return fail('reading_unresolved', { watch_id: watch.watch_id, run_key: key }); }
    // Native tools:run can return its completed result envelope. Unfinished runs stay unresolved.
    reading = reading?.result ?? reading;
    if (!reading || !['read', 'unread'].includes(reading.state)) return fail('reading_unresolved', { watch_id: watch.watch_id, run_key: key });
    const candidate = { observed_at: at, run_key: key, reading };
    const pending = { ...claimedRoot.value, in_flight: { ...claimedRoot.value.in_flight, phase: 'candidate', candidate,
      final_key: `${key}:finish`, next_due_at: new Date(Date.parse(at) + watch.every_minutes * 60000).toISOString() } };
    problem = await keep(door, writeOf(id, pending, claimedRoot), `${key}:candidate`);
    if (problem) return problem;
    const pendingRoot = await door.readRecord(TYPE, id);
    if (!sameEffect(pendingRoot, pending)) return fail('readback_changed');
    return finish(door, id, pendingRoot);
  }
  return unresolved[0] ?? { state: 'idle' };
}

export async function readSavedServiceWatches(input = {}, { door } = {}) {
  if (input.watch_id !== undefined) {
    const record = await door.readRecord(TYPE, idOf(input.watch_id));
    return { state: 'read', watches: record ? [record.value] : [], snapshots: record ? [{ watch_id: input.watch_id, expected: expectedOf(record) }] : [] };
  }
  const watches = [], snapshots = [];
  for await (const row of door.list({ type: TYPE, prefix: `${TYPE}:` })) {
    watches.push(row.value); snapshots.push({ watch_id: row.value.watch_id, expected: expectedOf(row) });
  }
  return { state: 'read', watches, snapshots };
}
