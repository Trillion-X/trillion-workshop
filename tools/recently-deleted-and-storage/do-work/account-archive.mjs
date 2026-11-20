// Account-owned metadata for the carried Recently Deleted/Archived semantics.
// Names and bytes stay exclusively in Native account_files. This module never opens
// a database or copies file bytes. Each item and bounded observation page is an
// ordinary account record, protected by the current whole-root opaque read identity.
//
// runTask constructs the production admitted-names.mjs adapter from the actual
// run door. Tests can inject admittedNames at this narrow contract boundary:
// protocol: 'fenced-names/1'; observe({tree,name,after,limit}) returns frozen exact
// name/identity/generation/destination_generation members; operation(original) and result(original) return
// committed, not_started or unknown. A committed move returns result.generation of
// the destination and destination_generation for the now-vacated source. result
// only consults the ORIGINAL receipt; it never executes.
// Legacy unconditioned methods do not satisfy it. The production adapter must
// receive a source/right-checked Native handshake before metadata creation.
//
// The exact key/body is stored before effect. prepared -> attempted is a CAS before
// the ONE first attempt. Restarted attempted/unknown commands only read the original
// receipt; missing/unavailable receipts never establish no effect or permit replay.
// Concurrent workers race on the same page root; only the winning CAS may attempt.
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';
import states from '../namespace-set-aside.json' with { type: 'json' };
import { DAY, fail, stateOf, daysFor, due, shown } from '../read-data/when-due.mjs';
import rules from '../durable-archive.json' with { type: 'json' };
import actionSchema from '../account-archive-actions.json' with { type: 'json' };
import { admittedNamesFromDoor } from './admitted-names.mjs';

export const inputSchema = actionSchema;

const copy = value => structuredClone(value);
// Native owns this reserved top-level stamp (run_capability.rs). Caused writes
// add it and uncaused writes remove it. Compare caller data without inventing a
// new stamp, while retaining the ACTUAL readback and its opaque root identity.
function callerValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { _wake_cause, ...data } = value;
  return data;
}
const sameValue = (left, right) => isDeepStrictEqual(callerValue(left), callerValue(right));
const hash = value => makeHashCodeHexFromJson(value).slice(3);
const pageId = (id, page) => `${id}:page:${String(page).padStart(12, '0')}`;
const exactName = name => typeof name === 'string' && name.startsWith('/') && name.length > 1 && !name.endsWith('/') && !name.includes('\0');
const fileIdentity = value => typeof value === 'string' && /^(1f|12):[0-9a-f]{64}$/.test(value);
const keyOf = input => {
  if (typeof input.request_key !== 'string' || !input.request_key || input.request_key.length > 1000) throw fail('request_key_required', 'Supply the original stable request_key.');
  return input.request_key;
};
async function supported(names, source) {
  if (typeof names?.ready === 'function') await names.ready(source);
  if (names?.protocol !== rules.names_protocol || ['observe', 'operation', 'result'].some(name => typeof names[name] !== 'function')) {
    throw fail('fenced_names_unavailable', 'The admitted names owner has not supplied conditioned operations and original-result recovery.');
  }
}
function choice(record) { return record?.value?.value ?? {}; }
function wake(id, at) { return { wake: { tool: rules.tool, at_ms: at, input: { action: 'tick', id } } }; }
function itemWake(item, keep, now) {
  if (['restored', 'forgotten', 'refused'].includes(item.status) || item.status === 'partial' && item.workflow.operation === 'forget_set_aside') return [];
  if (item.status === 'partial') {
    const at = due(item, keep);
    return at === null ? [] : [wake(item.id, Math.max(now + 1, at))];
  }
  if (item.status !== 'held') return [wake(item.id, now + (item.status === 'unknown' ? rules.recovery_wait_ms : 1))];
  const at = due(item, keep);
  return at === null ? [] : [wake(item.id, Math.max(now + 1, at))];
}

function actorFromTask(task) {
  const context = task?.context;
  if (context === undefined) return null;
  if (!context || typeof context !== 'object' || Array.isArray(context) || typeof context.account_id !== 'string' || !context.account_id
    || !['account', 'share_act'].includes(context.admission)) throw fail('native_context_invalid', 'The Native task supplied no valid admission context.');
  const actor = context.actor;
  if (actor === undefined && context.admission === 'share_act') return null;
  if (!actor || typeof actor !== 'object' || Array.isArray(actor) || typeof actor.id !== 'string' || !actor.id
    || context.admission === 'account' && (actor.kind !== 'account' || actor.id !== context.account_id)
    || context.admission === 'share_act' && actor.kind !== 'person') throw fail('native_context_invalid', 'The Native actor does not match its admission.');
  return { kind: actor.kind, id: actor.id };
}

// A descriptor uses a Native-filled envelope {input: caller input, task: task}.
// The task is separate from caller input and grants no rights of its own. This
// export remains unactivated until actual Native producer/result qualification.
export async function runTask({ input = {}, task } = {}, context = {}) {
  if (!task || typeof task.request_key !== 'string' || !task.request_key || task.task_id !== task.request_key) {
    throw fail('native_task_unavailable', 'The archive producer needs its actual Native task envelope.');
  }
  const request = ['archive', 'delete', 'put_back', 'forget', 'keep_for'].includes(input.action)
    ? { ...input, request_key: input.request_key ?? task.request_key } : input;
  const started = typeof task.started_at === 'string' ? Date.parse(task.started_at) : NaN;
  if (!Number.isFinite(started)) throw fail('native_clock_unavailable', 'The archive producer needs the actual Native task start time.');
  const door = context.door;
  return run(request, { door, admittedNames: context.admittedNames ?? admittedNamesFromDoor(door), task, now: started });
}

export async function run(input = {}, { door, admittedNames, task, now = Date.now() } = {}) {
  if (!door || typeof door.readRecord !== 'function' || typeof door.write !== 'function') throw fail('no_account_records', 'Use the current admitted account records door.');
  if (!Number.isFinite(now)) throw fail('bad_clock', 'The host clock must be finite.');
  const actor = actorFromTask(task);
  const read = (type, id) => door.readRecord(type, id);
  // One write, then current consumer readback. Never retry or rekey a failed write.
  async function save(type, id, before, value, purpose) {
    if (before && (typeof before.identity !== 'string' || !before.identity)) throw fail('current_identity_unavailable', 'The account read supplied no current root identity.');
    const record = { id, type, value, expected: before ? { type, identity: before.identity } : null };
    const key = `archive-record:${hash({ id, expected: record.expected, value, purpose })}`;
    try { await door.write([record], { key }); }
    catch (error) {
      if (error?.outcome !== 'unknown') throw error;
      const after = await read(type, id);
      if (sameValue(after?.value ?? null, value)) return after;
      throw fail('metadata_outcome_unknown', 'The exact metadata write has no verified readback; no file command was replayed.');
    }
    const after = await read(type, id);
    if (!sameValue(after?.value ?? null, value)) throw fail('metadata_readback_differs', 'The current archive metadata differs from the write.');
    return after;
  }
  const keepRecord = await read(rules.keep_for_type, rules.keep_for_id);
  const keep = choice(keepRecord);
  const load = async id => {
    if (typeof id !== 'string' || !id.startsWith(rules.item_prefix) || id.includes(':page:')) throw fail('bad_item', 'Give the exact archive item id.');
    const record = await read(rules.item_type, id);
    if (!record?.value || record.value.schema !== rules.schema || record.value.id !== id) throw fail('item_missing', 'No current archive item has that id.');
    return record;
  };
  const answer = item => ({ item: shown(item, keep, now), wake_effects: itemWake(item, keep, now) });

  if (input.action === 'cold_sweep') {
    // This is only a scalar position for a bounded cyclic read of the SAME
    // per-item records, not a work queue or scheduler. Advance AFTER consumer
    // work/readback, so a stop repeats recovery of that original item. Terminal
    // and unknown items never prevent later items receiving their bounded turn.
    let scan = await read(rules.scan_type, rules.scan_id);
    const prior = scan?.value?.after ?? null;
    const selected = [];
    for await (const row of door.list({ type: rules.item_type, ...(prior ? { below: prior } : {}), limit: rules.cold_items + 1 })) {
      if (selected.length >= rules.cold_items + 1) break;
      selected.push(row);
    }
    const page = selected.slice(0, rules.cold_items), results = [], effects = [];
    for (const row of page) {
      const result = await run({ action: 'tick', id: row.id }, { door, admittedNames, task, now });
      results.push({ id: row.id, status: result.item.status });
      effects.push(...result.wake_effects);
    }
    const after = selected.length > rules.cold_items ? page.at(-1).id : null;
    scan = await save(rules.scan_type, rules.scan_id, scan, { schema: rules.schema, after }, 'cold-scan-position');
    return { inspected: results, next_after: scan.value.after, wake_effects: effects };
  }

  if (input.action === 'read_keep_for') return { after_days: keep, states: states.states.map(row => ({ ...row, after_days: Object.hasOwn(keep, row.id) ? keep[row.id] : row.after_days })), wake_effects: [] };
  if (input.action === 'keep_for') {
    const requestKey = keyOf(input);
    if (!input.after_days || typeof input.after_days !== 'object' || Array.isArray(input.after_days)) throw fail('bad_keep_for', 'Supply after_days by state.');
    for (const [state, days] of Object.entries(input.after_days)) {
      stateOf(state);
      if (days !== null && (!Number.isInteger(days) || days < 0 || days > states.max_days)) throw fail('bad_keep_for', 'Choose a whole allowed day count, or null.');
    }
    const id = `namespace-lifecycle-command:${hash(requestKey)}`;
    let command = await read(rules.command_type, id);
    if (command && !isDeepStrictEqual(command.value.request, input)) throw fail('original_input_conflict', 'This original request key already names different input.');
    if (!command) {
      const value = { ...(keepRecord?.value ?? {}), value: { ...keep, ...input.after_days } };
      if (keepRecord && !keepRecord.identity) throw fail('current_identity_unavailable', 'The current keep-for read has no root identity.');
      command = await save(rules.command_type, id, null, { request: copy(input), phase: 'prepared', original: {
        request_key: `archive-keep:${hash(requestKey)}`, operation: 'records:write', input: { records: [{
          id: rules.keep_for_id, type: rules.keep_for_type, value,
          expected: keepRecord ? { type: rules.keep_for_type, identity: keepRecord.identity } : null,
        }] },
      } }, 'prepare-keep-for');
    }
    if (command.value.phase === 'prepared') {
      const attempted = { ...command.value, phase: 'attempted' };
      command = await save(rules.command_type, id, command, attempted, 'before-keep-for');
      const original = command.value.original;
      // A lost response leaves this phase attempted. A later invocation never writes
      // it again, even when the current value matches; original outcome stays unknown.
      await door.write(original.input.records, { key: original.request_key });
      const observed = await read(rules.keep_for_type, rules.keep_for_id);
      if (!sameValue(observed?.value, original.input.records[0].value)) throw fail('metadata_readback_differs', 'The current keep-for value differs from the original write.');
      command = await save(rules.command_type, id, command, { ...command.value, phase: 'committed' }, 'keep-for-committed');
    }
    if (command.value.phase !== 'committed') {
      if (typeof door.result !== 'function') throw fail('original_result_required', 'The original keep-for write needs its admitted receipt; it was not replayed.');
      const receipt = await door.result(copy(command.value.original));
      if (!receipt || typeof receipt !== 'object') throw fail('original_result_required', 'No original keep-for receipt was returned; the command was not replayed.');
      command = await save(rules.command_type, id, command, { ...command.value, phase: 'committed', receipt }, 'recover-keep-for');
    }
    const current = await read(rules.keep_for_type, rules.keep_for_id);
    return { after_days: choice(current), original_after_days: command.value.original.input.records[0].value.value,
      wake_effects: [{ wake: { tool: rules.tool, at_ms: now + 1, input: { action: 'sweep' } } }] };
  }
  if (input.action === 'read') return answer((await load(input.id)).value);
  if (input.action === 'list' || input.action === 'sweep') {
    const effects = [], items = [];
    let more = false;
    for await (const record of door.list({ type: rules.item_type, ...(input.after ? { below: input.after } : {}), limit: rules.sweep_items + 1 })) {
      if (items.length === rules.sweep_items) { more = true; break; }
      if (!record.value || record.value.schema !== rules.schema) throw fail('metadata_invalid', 'The archive listing contains an unsupported item.');
      items.push(shown(record.value, keep, now));
      if (input.action === 'sweep') effects.push(...itemWake(record.value, keep, now));
    }
    const next = more ? items.at(-1).id : null;
    if (next && input.action === 'sweep') effects.push({ wake: { tool: rules.tool, at_ms: now + 1, input: { action: 'sweep', after: next } } });
    return { items, next_after: next, wake_effects: effects };
  }
  let record;
  if (input.action === 'archive' || input.action === 'delete') {
    const requestKey = keyOf(input);
    if (!exactName(input.name)) throw fail('bad_name', 'Choose an exact file or folder inside Files.');
    await supported(admittedNames, { tree: 'live', name: input.name });
    const id = `${rules.item_prefix}${hash(requestKey)}`;
    record = await read(rules.item_type, id);
    if (record) {
      if (!isDeepStrictEqual(record.value.request, input)) throw fail('original_input_conflict', 'This original request key already names different input.');
    } else {
      record = await save(rules.item_type, id, null, { schema: rules.schema, id, request: copy(input),
        name: input.name, label: input.name.split('/').at(-1), state: input.action === 'archive' ? 'archived' : 'deleted',
        created_at_ms: now, entered_at_ms: null, by: actor?.id ?? null, actor, requested_by_label: input.by ?? null, status: 'observing', pages: 0, member_count: 0, scan_after: null,
        page: 0, member: 0, workflow: { operation: 'set_aside', request_key: requestKey }, conflicts: 0 }, 'create');
    }
  } else {
    record = await load(input.id);
    await supported(admittedNames, { tree: record.value.workflow.operation === 'set_aside' && record.value.status === 'observing' ? 'live' : 'set_aside', name: record.value.name });
  }
  let item = copy(record.value);
  if (input.action === 'put_back' || input.action === 'forget') {
    const requestKey = keyOf(input);
    const operation = input.action === 'put_back' ? 'put_back' : 'forget_set_aside';
    const workflow = { operation, request_key: requestKey, request: copy(input) };
    if (item.workflow?.request_key === requestKey) {
      if (!isDeepStrictEqual(item.workflow, workflow)) throw fail('original_input_conflict', 'This original key has different input.');
    } else {
      if (!['held', 'partial'].includes(item.status)) throw fail('item_busy', 'Finish or reconcile the current archive operation first.');
      item = { ...item, workflow, status: 'applying', page: 0, member: 0, conflicts: 0 };
      record = await save(rules.item_type, item.id, record, item, 'start-action');
    }
  } else if (input.action === 'tick' && ['held', 'partial'].includes(item.status)) {
    const at = due(item, keep);
    if (at === null || at > now) return answer(item);
    const target = stateOf(item.state).when_due;
    if (target !== null) {
      item = { ...item, state: stateOf(target).id, entered_at_ms: now, by: 'schedule' };
      await save(rules.item_type, item.id, record, item, 'advance-state');
      return answer(item);
    }
    item = { ...item, status: 'applying', page: 0, member: 0, conflicts: 0,
      workflow: { operation: 'forget_set_aside', request_key: `retention:${item.id}:${item.entered_at_ms}:${at}` } };
    record = await save(rules.item_type, item.id, record, item, 'start-retention');
  } else if (!['archive', 'delete', 'continue', 'tick'].includes(input.action)) throw fail('bad_action', 'Choose archive, delete, read, list, continue, put_back, forget, keep_for, read_keep_for, sweep or tick.');

  for (let work = 0; work < rules.work_per_run; work += 1) {
    if (item.status === 'observing') {
      // Observe before ANY name effect. Each bounded page retains only exact member
      // source witnesses needed to protect this item, not an independent namespace.
      const observed = await admittedNames.observe({ tree: 'live', name: item.name, after: item.scan_after, limit: rules.page_members });
      const folders = observed?.folders ?? [];
      const members = Array.isArray(observed?.members) && Array.isArray(folders) ? [...observed.members, ...folders] : null;
      if (!members || members.length > rules.page_members || !Object.hasOwn(observed, 'next_after')
        || (observed.next_after !== null && (typeof observed.next_after !== 'string' || observed.next_after === item.scan_after))
        || members.some(member => !exactName(member.name) || !(member.name === item.name || member.name.startsWith(`${item.name}/`))
          || member.folder !== true && !fileIdentity(member.identity) || typeof member.generation !== 'string' || !member.generation
          || typeof member.destination_generation !== 'string' || !member.destination_generation)
        || new Set(members.map(member => member.name)).size !== members.length) throw fail('observation_invalid', 'The admitted names owner returned no bounded frozen source witnesses.');
      const id = pageId(item.id, item.pages);
      const page = { schema: rules.schema, item: item.id, index: item.pages, members: members.map(({ name, identity, folder, generation, destination_generation }) => ({ name, ...(folder === true ? { folder: true } : { identity }), generation, destination_generation, tree: 'live', command: null })) };
      const beforePage = await read(rules.page_type, id);
      if (beforePage && !sameValue(beforePage.value, page)) throw fail('observation_conflict', 'A previously frozen observation page differs; no name was changed.');
      if (!beforePage) await save(rules.page_type, id, null, page, 'freeze-members');
      const memberCount = item.member_count + members.length;
      item = { ...item, pages: item.pages + 1, member_count: memberCount, scan_after: observed.next_after,
        folder: Boolean(observed.folder), status: observed.next_after === null ? memberCount ? 'applying' : 'refused' : 'observing' };
      record = await save(rules.item_type, item.id, record, item, 'advance-observation');
      continue;
    }
    if (!['applying', 'unknown'].includes(item.status)) break;
    if (item.page >= item.pages) {
      if (item.workflow.operation === 'set_aside') {
        // A name created behind the observation cursor (or after its page was
        // frozen) was never authorized by that frozen witness. Leave it where it
        // is and report the incomplete folder action instead of declaring success.
        const remainder = await admittedNames.observe({ tree: 'live', name: item.name, after: null, limit: 1 });
        if (!Array.isArray(remainder?.members) || remainder.members.length > 1) throw fail('observation_invalid', 'The source completeness read was not bounded.');
        if (remainder.members.length) item = { ...item, conflicts: Math.max(item.conflicts, 1), remaining_source_name: remainder.members[0].name };
        if (remainder.folder === true) item = { ...item, conflicts: Math.max(item.conflicts, 1), source_folder_remains: true };
      }
      const status = item.conflicts ? 'partial' : item.workflow.operation === 'set_aside' ? 'held' : item.workflow.operation === 'put_back' ? 'restored' : 'forgotten';
      item = { ...item, status };
      await save(rules.item_type, item.id, record, item, 'finish');
      break;
    }
    const id = pageId(item.id, item.page);
    let pageRecord = await read(rules.page_type, id);
    if (!pageRecord?.value || pageRecord.value.item !== item.id) throw fail('page_missing', 'A frozen archive member page is unavailable.');
    const page = copy(pageRecord.value);
    if (item.member >= page.members.length) {
      item = { ...item, page: item.page + 1, member: 0 };
      record = await save(rules.item_type, item.id, record, item, 'next-page'); continue;
    }
    const member = page.members[item.member];
    const operation = item.workflow.operation;
    const commandKey = `archive-name:${hash({ key: item.workflow.request_key, id, member: item.member })}`;
    const sourceTree = operation === 'set_aside' ? 'live' : 'set_aside';
    if (member.tree !== sourceTree) {
      const enteredAt = operation === 'set_aside' && member.command?.phase === 'committed' && member.command.original.request_key === commandKey
        ? member.command.attempted_at_ms : null;
      item = { ...item, member: item.member + 1, entered_at_ms: item.entered_at_ms ?? enteredAt };
      record = await save(rules.item_type, item.id, record, item, 'skip-other-tree'); continue;
    }
    if ((operation === 'put_back' || member.folder) && operation !== 'forget_set_aside' && member.command?.original.request_key !== commandKey) {
      // This is a NEW explicit restore intent, not replay of the prior command.
      // Observe its current destination witness (e.g. after a conflict was cleared)
      // while retaining the archived ORIGINAL source witness across name ABA.
      const observed = await admittedNames.observe({ tree: sourceTree, name: member.name, after: null, limit: 1 });
      const current = [...observed?.members ?? [], ...observed?.folders ?? []].find(row => row.name === member.name && row.generation === member.generation && Boolean(row.folder) === Boolean(member.folder));
      if (current && typeof current.destination_generation === 'string' && current.destination_generation) member.destination_generation = current.destination_generation;
    }
    const original = { request_key: commandKey, operation: admittedNames.effects?.[operation] ?? operation,
      input: { name: member.name, expected_generation: member.generation,
        ...(member.folder ? { folder: true } : {}),
        ...(operation === 'forget_set_aside' ? {} : { expected_destination_generation: member.destination_generation }) } };
    if (!member.command || member.command.original.request_key !== original.request_key) {
      member.command = { original, phase: 'prepared' };
      pageRecord = await save(rules.page_type, id, pageRecord, page, 'prepare-original');
    } else if (!isDeepStrictEqual(member.command.original, original)) throw fail('original_input_conflict', 'The frozen name command changed.');
    let outcome;
    if (member.command.phase === 'prepared') {
      member.command.phase = 'attempted';
      member.command.attempted_at_ms = now;
      // A distinct contender must make a distinct CAS claim. Reusing the same
      // metadata command key could return a replayed write receipt to BOTH workers,
      // which does not grant both workers permission for a first name attempt.
      member.command.attempt_id = randomUUID();
      pageRecord = await save(rules.page_type, id, pageRecord, page, 'before-first-attempt');
      try { outcome = await admittedNames.operation(copy(original)); }
      catch { outcome = { status: 'unknown' }; }
    } else if (member.command.phase === 'committed' || member.command.phase === 'not_started') outcome = member.command.outcome;
    else {
      try { outcome = await admittedNames.result(copy(original)); }
      catch { outcome = { status: 'unknown' }; }
    }
    if (!['committed', 'not_started', 'unknown'].includes(outcome?.status)) outcome = { status: 'unknown', code: 'receipt_unavailable' };
    if (outcome.status === 'committed' && operation !== 'forget_set_aside' && (typeof outcome.result?.generation !== 'string' || !outcome.result.generation
      || typeof outcome.result?.destination_generation !== 'string' || !outcome.result.destination_generation)) {
      outcome = { status: 'unknown', code: 'destination_generation_unavailable' };
    }
    member.command.phase = outcome.status; member.command.outcome = copy(outcome);
    if (outcome.status === 'committed') {
      member.tree = operation === 'set_aside' ? 'set_aside' : operation === 'put_back' ? 'live' : 'forgotten';
      if (outcome.result?.generation) member.generation = outcome.result.generation;
      if (outcome.result?.destination_generation) member.destination_generation = outcome.result.destination_generation;
    }
    await save(rules.page_type, id, pageRecord, page, 'keep-original-outcome');
    if (outcome.status === 'unknown') {
      item = { ...item, status: 'unknown' };
      await save(rules.item_type, item.id, record, item, 'unknown-original'); break;
    }
    const enteredAt = operation === 'set_aside' && outcome.status === 'committed' ? member.command.attempted_at_ms : null;
    item = { ...item, status: 'applying', member: item.member + 1, entered_at_ms: item.entered_at_ms ?? enteredAt,
      conflicts: item.conflicts + (outcome.status === 'not_started' ? 1 : 0) };
    record = await save(rules.item_type, item.id, record, item, 'advance-member');
  }
  return answer(item);
}
