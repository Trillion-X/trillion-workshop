// Synthetic admitted-owner contract controls. The retained JSON below models owner
// readback/restart only; it is NOT a new product store or a Native integration proof.
import assert from 'node:assert/strict';
import test from 'node:test';
import { run, runTask, inputSchema } from '../do-work/account-archive.mjs';
import rules from '../durable-archive.json' with { type: 'json' };
import descriptorCandidate from '../ports/account-archive-descriptor.candidate.json' with { type: 'json' };

const clone = structuredClone;
const epoch = Date.parse('2026-11-01T00:00:00Z');
const identity = `1f:${'a'.repeat(64)}`;
class Account {
  constructor(saved) {
    this.saved = saved ?? { records: {}, live: {}, set_aside: {}, folders: { live: {}, set_aside: {} }, generations: { live: {}, set_aside: {} }, receipts: {}, recordReceipts: {}, serial: 0, effects: 0, writes: 0, settingAttempts: 0 };
    this.allowed = true;
    this.dropEffectAnswer = false;
    this.hideReceipt = false;
  }
  restart() { return new Account(JSON.parse(JSON.stringify(this.saved))); }
  generation(tree, name) { return this.saved.generations[tree][name] ?? 'name:absent:0'; }
  add(name, value = identity) {
    const generation = `name:${++this.saved.serial}`; this.saved.generations.live[name] = generation;
    this.saved.live[name] = { name, identity: value, generation };
    if (this.keepEmptyFolders) this.saved.folders.live[name.slice(0, name.lastIndexOf('/'))] = `folder:${++this.saved.serial}`;
  }
  remove(name) { delete this.saved.live[name]; this.saved.generations.live[name] = `name:${++this.saved.serial}`; }
  get door() {
    const owner = this;
    return {
      async readRecord(type, id) { return clone(owner.saved.records[`${type}|${id}`] ?? null); },
      async write(records, { key }) {
        const setting = records.some(record => record.id === 'setting:keep_for');
        if (setting) owner.saved.settingAttempts += 1;
        if (!owner.allowed) throw Object.assign(new Error('rights revoked'), { code: 'current_workspace_rights_refused' });
        const original = { request_key: key, operation: 'records:write', input: { records } };
        const found = owner.saved.recordReceipts[key];
        if (found) { assert.deepEqual(found.original, original); return clone(found.result); }
        for (const record of records) {
          const held = owner.saved.records[`${record.type}|${record.id}`];
          if (record.expected === null ? Boolean(held) : held?.identity !== record.expected?.identity) throw Object.assign(new Error('CAS conflict'), { code: 'original_command_conflict', outcome: 'not_started' });
        }
        for (const record of records) {
          const value = clone(record.value);
          if (owner.wakeCause) value._wake_cause = owner.wakeCause;
          else delete value._wake_cause;
          owner.saved.records[`${record.type}|${record.id}`] = {
            type: record.type, value, identity: `root:${++owner.saved.serial}`,
          };
        }
        owner.saved.writes += 1;
        const result = { changed: records.length, write_count: records.length };
        owner.saved.recordReceipts[key] = { original: clone(original), result };
        if (setting && owner.dropSettingAnswer) { owner.dropSettingAnswer = false; throw Object.assign(new Error('setting answer lost'), { outcome: 'unknown' }); }
        return result;
      },
      async result(original) {
        const held = owner.saved.recordReceipts[original.request_key];
        if (!held) throw Object.assign(new Error('unknown original'), { outcome: 'unknown' });
        assert.deepEqual(held.original, original); return clone(held.result);
      },
      async *list({ type, below }) {
        const entries = Object.entries(owner.saved.records).filter(([key]) => key.startsWith(`${type}|`))
          .map(([key, record]) => ({ id: key.slice(type.length + 1), ...clone(record) })).sort((a, b) => b.id.localeCompare(a.id));
        for (const record of entries) if (!below || record.id < below) yield record;
      },
    };
  }
  get names() {
    const owner = this;
    return {
      protocol: 'fenced-names/1',
      async observe({ tree, name, after, limit }) {
        owner.observations = (owner.observations ?? 0) + 1;
        limit = Math.min(limit, owner.observeLimit ?? limit);
        const all = Object.values(owner.saved[tree]).filter(row => row.name === name || row.name.startsWith(`${name}/`))
          .filter(row => !after || row.name > after).sort((a, b) => a.name.localeCompare(b.name));
        const target = tree === 'live' ? 'set_aside' : 'live';
        const folderRows = owner.folderProtocol ? Object.entries(owner.saved.folders[tree])
          .filter(([path]) => path === name || path.startsWith(`${name}/`))
          .sort(([a], [b]) => b.length - a.length || a.localeCompare(b))
          .map(([path, generation]) => ({ name: path, folder: true, generation, destination_generation: owner.saved.folders[target][path] ?? 'folder:absent:0' })) : [];
        return { members: all.slice(0, limit).map(row => ({ ...clone(row), destination_generation: owner.generation(target, row.name) })),
          folders: all.length < limit ? folderRows.slice(0, limit - all.length) : [], next_after: all.length > limit ? all[limit - 1].name : null,
          folder: Boolean(owner.saved.folders[tree][name]) || all.some(row => row.name !== name) };
      },
      async operation(original) {
        owner.saved.effects += 1;
        const { operation, input, request_key: key } = original;
        assert.equal(owner.saved.receipts[key], undefined, 'the core never replays an attempted name effect');
        const tree = operation === 'set_aside' ? 'live' : 'set_aside';
        const target = operation === 'set_aside' ? 'set_aside' : 'live';
        if (input.folder === true) {
          const generation = owner.saved.folders[tree][input.name];
          const hasChildren = Object.keys(owner.saved[tree]).some(name => name.startsWith(`${input.name}/`))
            || Object.keys(owner.saved.folders[tree]).some(name => name.startsWith(`${input.name}/`));
          let answer;
          if (!generation || generation !== input.expected_generation || hasChildren) answer = { status: 'not_started', code: 'folder_changed_or_not_empty' };
          else if (operation !== 'forget_set_aside' && (owner.saved.folders[target][input.name] ?? 'folder:absent:0') !== input.expected_destination_generation) answer = { status: 'not_started', code: 'destination_changed' };
          else {
            delete owner.saved.folders[tree][input.name];
            if (operation !== 'forget_set_aside') owner.saved.folders[target][input.name] ??= `folder:${++owner.saved.serial}`;
            answer = { status: 'committed', result: operation === 'forget_set_aside' ? { folder: true, forgotten: true } : {
              folder: true, generation: owner.saved.folders[target][input.name], destination_generation: 'folder:absent:0',
            } };
          }
          owner.saved.receipts[key] = { original: clone(original), answer: clone(answer) };
          return answer;
        }
        const row = owner.saved[tree][input.name];
        let answer;
        if (!owner.allowed) answer = { status: 'not_started', code: 'rights_revoked' };
        else if (!row || row.generation !== input.expected_generation) answer = { status: 'not_started', code: 'stale_generation' };
        else if (operation !== 'forget_set_aside' && owner.generation(target, input.name) !== input.expected_destination_generation) answer = { status: 'not_started', code: 'stale_destination_generation' };
        else if (operation !== 'forget_set_aside' && owner.saved[target][input.name]) answer = { status: 'not_started', code: 'destination_occupied' };
        else {
          delete owner.saved[tree][input.name];
          const generation = `name:${++owner.saved.serial}`;
          owner.saved.generations[tree][input.name] = `name:${++owner.saved.serial}`;
          if (operation !== 'forget_set_aside') {
            owner.saved[target][input.name] = { ...row, generation }; owner.saved.generations[target][input.name] = generation;
            if (owner.folderProtocol) owner.saved.folders[target][input.name.slice(0, input.name.lastIndexOf('/'))] ??= `folder:${++owner.saved.serial}`;
          }
          answer = { status: 'committed', result: operation === 'forget_set_aside' ? { noted: [row.identity] } : { generation, destination_generation: owner.generation(tree, input.name) } };
        }
        owner.saved.receipts[key] = { original: clone(original), answer: clone(answer) };
        if (owner.dropEffectAnswer) { owner.dropEffectAnswer = false; throw new Error('lost transport AFTER stored effect'); }
        return answer;
      },
      async result(original) {
        const held = owner.saved.receipts[original.request_key];
        if (!held || owner.hideReceipt) return { status: 'unknown', code: 'receipt_unavailable' };
        assert.deepEqual(held.original, original, 'recovery retains exact original body and key');
        return clone(held.answer);
      },
    };
  }
  call(input, at = epoch, extra = {}) { return run(input, { door: this.door, admittedNames: this.names, now: at, ...extra }); }
}
async function finish(account, first, at = epoch) {
  let answer = first;
  for (let attempts = 0; ['observing', 'applying'].includes(answer.item.status) && attempts < 100; attempts += 1) {
    answer = await account.call({ action: 'continue', id: answer.item.id }, at);
  }
  return answer;
}

test('unsupported current Native protocol refuses before metadata or file mutation', async () => {
  const account = new Account(); account.add('/note.txt');
  await assert.rejects(account.call({ action: 'archive', name: '/note.txt', request_key: 'a' }, epoch, { admittedNames: { protocol: 'unconditioned' } }), { code: 'fenced_names_unavailable' });
  assert.equal(account.saved.writes, 0); assert.equal(account.saved.effects, 0);
});

test('account records retain archive, cold readback, restore and destination generation', async () => {
  let account = new Account(); account.add('/folder/a'); account.add('/folder/b');
  let answer = await finish(account, await account.call({ action: 'archive', name: '/folder', request_key: 'folder' }));
  assert.equal(answer.item.status, 'held'); assert.deepEqual(Object.keys(account.saved.live), []);
  assert.equal(answer.wake_effects[0].wake.at_ms, epoch + 30 * 86400000);
  account = account.restart();
  const readback = await account.call({ action: 'read', id: answer.item.id });
  assert.equal(readback.item.status, 'held');
  answer = await finish(account, await account.call({ action: 'put_back', id: answer.item.id, request_key: 'restore' }));
  assert.equal(answer.item.status, 'restored'); assert.deepEqual(Object.keys(account.saved.live).sort(), ['/folder/a', '/folder/b']);
  assert.equal(answer.wake_effects.length, 0);
});

test('wake consumer transitions Archived to Deleted, then forgets only names', async () => {
  const account = new Account(); account.add('/note.txt');
  let answer = await account.call({ action: 'archive', name: '/note.txt', request_key: 'retention' });
  answer = await account.call({ action: 'tick', id: answer.item.id }, epoch + 30 * 86400000);
  assert.equal(answer.item.state, 'deleted'); assert.equal(answer.item.status, 'held');
  answer = await account.call({ action: 'tick', id: answer.item.id }, epoch + 60 * 86400000);
  assert.equal(answer.item.status, 'forgotten');
  assert.deepEqual(account.saved.set_aside, {});
  assert.equal(Object.values(account.saved.receipts).at(-1).answer.result.noted[0], identity);
  const calls = account.saved.effects;
  await account.call({ action: 'tick', id: answer.item.id }, epoch + 61 * 86400000);
  assert.equal(account.saved.effects, calls);
});

test('lost committed answer reconciles original receipt after restart without another name effect', async () => {
  let account = new Account(); account.add('/note.txt'); account.dropEffectAnswer = true;
  let answer = await account.call({ action: 'delete', name: '/note.txt', request_key: 'lost-answer' });
  assert.equal(answer.item.status, 'unknown'); assert.equal(account.saved.effects, 1);
  account = account.restart();
  answer = await account.call({ action: 'continue', id: answer.item.id });
  assert.equal(answer.item.status, 'held'); assert.equal(account.saved.effects, 1);
});

test('unavailable original receipt stays unknown and never becomes no effect or a replay', async () => {
  const account = new Account(); account.add('/note.txt'); account.dropEffectAnswer = true;
  let answer = await account.call({ action: 'delete', name: '/note.txt', request_key: 'unknown' });
  account.hideReceipt = true;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    answer = await account.call({ action: 'continue', id: answer.item.id });
    assert.equal(answer.item.status, 'unknown');
  }
  assert.equal(account.saved.effects, 1);
  await assert.rejects(account.call({ action: 'put_back', id: answer.item.id, request_key: 'unsafe-next' }), { code: 'item_busy' });
});

test('occupied restore name retains archived original and permits a new explicit restore after conflict is cleared', async () => {
  const account = new Account(); account.add('/note.txt');
  const held = await account.call({ action: 'archive', name: '/note.txt', request_key: 'original' });
  account.add('/note.txt', `1f:${'b'.repeat(64)}`);
  let answer = await account.call({ action: 'put_back', id: held.item.id, request_key: 'conflict' });
  assert.equal(answer.item.status, 'partial'); assert.equal(account.saved.set_aside['/note.txt'].identity, identity);
  assert.equal(answer.wake_effects[0].wake.at_ms, epoch + 30 * 86400000, 'a restore conflict retains the original retention deadline rather than retrying now');
  account.remove('/note.txt');
  answer = await account.call({ action: 'put_back', id: held.item.id, request_key: 'new-explicit-restore' });
  assert.equal(answer.item.status, 'restored'); assert.equal(account.saved.live['/note.txt'].identity, identity);
});

test('fresh Native rights refusal never changes names', async () => {
  const account = new Account(); account.add('/note.txt');
  const names = account.names;
  names.operation = async () => ({ status: 'not_started', code: 'rights_revoked' });
  const answer = await account.call({ action: 'delete', name: '/note.txt', request_key: 'revoked' }, epoch, { admittedNames: names });
  assert.equal(answer.item.status, 'partial'); assert.equal(account.saved.live['/note.txt'].identity, identity);
});

test('concurrent same request loses CAS before its first name effect', async () => {
  const account = new Account(); account.add('/note.txt');
  const outcomes = await Promise.allSettled([account.call({ action: 'archive', name: '/note.txt', request_key: 'race' }), account.call({ action: 'archive', name: '/note.txt', request_key: 'race' })]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(result => result.status === 'rejected').reason.code, 'original_command_conflict');
  assert.equal(account.saved.effects, 1);
});

test('bounded folder observation freezes members before any effect and refuses changed identical-byte names', async () => {
  const account = new Account();
  account.observeLimit = 1;
  for (let i = 0; i < rules.work_per_run + 1; i += 1) account.add(`/folder/${String(i).padStart(5, '0')}`);
  let answer = await account.call({ action: 'archive', name: '/folder', request_key: 'bounded' });
  assert.equal(answer.item.status, 'observing'); assert.equal(account.saved.effects, 0);
  assert.equal(answer.item.due_at, null, 'observation time is not represented as time already archived');
  account.add('/folder/00000'); // identical content, NEW name generation
  answer = await finish(account, await account.call({ action: 'continue', id: answer.item.id }));
  assert.equal(answer.item.status, 'partial'); assert.equal(account.saved.live['/folder/00000'].identity, identity);
  assert.equal(Object.keys(account.saved.set_aside).length, rules.work_per_run);
});

test('existing keep_for root and siblings survive edits; original key cannot overwrite later settings', async () => {
  const account = new Account();
  account.saved.records['setting|setting:keep_for'] = { type: 'setting', identity: 'root:existing', value: { value: { deleted: 7 }, unrelated: 'preserved' } };
  const request = { action: 'keep_for', after_days: { archived: null }, request_key: 'choice' };
  let answer = await account.call(request);
  assert.deepEqual(answer.after_days, { deleted: 7, archived: null });
  assert.equal(account.saved.records['setting|setting:keep_for'].value.unrelated, 'preserved');
  assert.equal(answer.wake_effects[0].wake.input.action, 'sweep');
  await account.call({ action: 'keep_for', after_days: { archived: 90 }, request_key: 'later-choice' });
  answer = await account.call(request);
  assert.equal(answer.after_days.archived, 90, 'replaying original choice does not overwrite the newer one');
  await assert.rejects(account.call({ ...request, after_days: { archived: 3 } }), { code: 'original_input_conflict' });
});

test('same original archive key with different input is refused', async () => {
  const account = new Account(); account.add('/one'); account.add('/two');
  await account.call({ action: 'archive', name: '/one', request_key: 'one-original' });
  await assert.rejects(account.call({ action: 'archive', name: '/two', request_key: 'one-original' }), { code: 'original_input_conflict' });
  assert.equal(account.saved.live['/two'].identity, identity);
});

test('cold keep_for recovery reads its original receipt without repeating the stored write', async () => {
  let account = new Account(); account.dropSettingAnswer = true;
  const request = { action: 'keep_for', after_days: { archived: null }, request_key: 'lost-choice-answer' };
  await assert.rejects(account.call(request), { outcome: 'unknown' });
  assert.equal(account.saved.settingAttempts, 1);
  account = account.restart();
  const answer = await account.call(request);
  assert.equal(answer.after_days.archived, null);
  assert.equal(account.saved.settingAttempts, 1);
});

test('concurrent settings preserve the complete root by refusing the stale writer', async () => {
  const account = new Account();
  account.saved.records['setting|setting:keep_for'] = { type: 'setting', identity: 'root:existing', value: { value: { deleted: 7, archived: 30 }, unrelated: 'kept' } };
  const outcomes = await Promise.allSettled([
    account.call({ action: 'keep_for', after_days: { deleted: 10 }, request_key: 'deleted-choice' }),
    account.call({ action: 'keep_for', after_days: { archived: 90 }, request_key: 'archived-choice' }),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(result => result.status === 'rejected').reason.code, 'original_command_conflict');
  assert.equal(account.saved.records['setting|setting:keep_for'].value.unrelated, 'kept');
});

test('names added behind the observation cursor remain live and make the folder result partial', async () => {
  const account = new Account(); account.observeLimit = 1;
  for (let i = 0; i < rules.work_per_run + 1; i += 1) account.add(`/folder/b${String(i).padStart(5, '0')}`);
  let answer = await account.call({ action: 'archive', name: '/folder', request_key: 'new-member' });
  assert.equal(answer.item.status, 'observing');
  account.add('/folder/a-new');
  answer = await finish(account, await account.call({ action: 'continue', id: answer.item.id }));
  assert.equal(answer.item.status, 'partial'); assert.equal(answer.item.remaining_source_name, '/folder/a-new');
  assert.equal(account.saved.live['/folder/a-new'].identity, identity);
});

test('Native wake stamping and a later manual unstamp preserve actual consumer readback identities', async () => {
  const account = new Account(); account.add('/note'); account.wakeCause = 'native-attested-cause';
  let answer = await account.call({ action: 'archive', name: '/note', request_key: 'caused', by: 'caller-supplied-name' });
  assert.equal(answer.item.status, 'held'); assert.equal(answer.item.by, null);
  assert.equal(answer.item.requested_by_label, 'caller-supplied-name');
  const id = answer.item.id;
  assert.equal(account.saved.records[`${rules.item_type}|${id}`].value._wake_cause, 'native-attested-cause');
  account.wakeCause = null;
  answer = await account.call({ action: 'put_back', id, request_key: 'manual-restore' });
  assert.equal(answer.item.status, 'restored');
  assert.equal(account.saved.records[`${rules.item_type}|${id}`].value._wake_cause, undefined);
});

test('Native descending item-id pagination continues below the last id without a repeat or a skip', async () => {
  const account = new Account();
  for (let index = 0; index < rules.sweep_items * 2 + 1; index += 1) {
    const name = `/note-${index}`; account.add(name);
    await account.call({ action: 'archive', name, request_key: `page-${index}` });
  }
  const ids = [];
  let after;
  do {
    const answer = await account.call({ action: 'sweep', ...(after ? { after } : {}) });
    assert.ok(answer.wake_effects.length <= 20, 'item wakes plus continuation fit Native tool-runs.json max_effects');
    ids.push(...answer.items.map(item => item.id));
    after = answer.next_after;
  } while (after);
  assert.equal(ids.length, rules.sweep_items * 2 + 1);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, [...ids].sort().reverse());
});

test('an unpruned Native source folder marker prevents a false whole-folder completion claim', async () => {
  const account = new Account(); account.keepEmptyFolders = true; account.add('/folder/note');
  const answer = await account.call({ action: 'archive', name: '/folder', request_key: 'folder-markers' });
  assert.equal(answer.item.status, 'partial'); assert.equal(answer.item.source_folder_remains, true);
  assert.ok(account.saved.folders.live['/folder']);
  assert.equal(account.saved.set_aside['/folder/note'].identity, identity);
});

test('a replaced archived source cannot be silently adopted by a new restore intent', async () => {
  const account = new Account(); account.add('/note');
  const held = await account.call({ action: 'archive', name: '/note', request_key: 'retain-original' });
  const replacement = { name: '/note', identity: `1f:${'b'.repeat(64)}`, generation: 'name:replacement-aside' };
  account.saved.set_aside['/note'] = replacement;
  account.saved.generations.set_aside['/note'] = replacement.generation;
  const answer = await account.call({ action: 'put_back', id: held.item.id, request_key: 'do-not-adopt-replacement' });
  assert.equal(answer.item.status, 'partial');
  assert.deepEqual(account.saved.set_aside['/note'], replacement);
  assert.equal(account.saved.live['/note'], undefined);
});

test('an absent destination that underwent ABA after observation refuses the frozen archive', async () => {
  const account = new Account(); account.add('/note');
  const names = account.names, operation = names.operation;
  names.operation = async original => {
    account.saved.generations.set_aside['/note'] = 'name:placed-then-removed';
    return operation(original);
  };
  const answer = await account.call({ action: 'archive', name: '/note', request_key: 'destination-aba' }, epoch, { admittedNames: names });
  assert.equal(answer.item.status, 'partial'); assert.equal(account.saved.live['/note'].identity, identity);
  assert.equal(Object.values(account.saved.receipts)[0].answer.code, 'stale_destination_generation');
});

test('missing keep_for original receipt cannot trigger a new write or a changed key', async () => {
  const account = new Account(); account.dropSettingAnswer = true;
  const request = { action: 'keep_for', after_days: { archived: 90 }, request_key: 'choice-with-missing-receipt' };
  await assert.rejects(account.call(request), { outcome: 'unknown' });
  const settingsKey = Object.keys(account.saved.recordReceipts).find(key => key.startsWith('archive-keep:'));
  delete account.saved.recordReceipts[settingsKey];
  await assert.rejects(account.call(request), { outcome: 'unknown' });
  assert.equal(account.saved.settingAttempts, 1);
});

test('retention begins with the first confirmed name attempt rather than a long-running observation', async () => {
  const account = new Account(); account.observeLimit = 1;
  for (let index = 0; index < rules.work_per_run + 1; index += 1) account.add(`/folder/${String(index).padStart(5, '0')}`);
  let answer = await account.call({ action: 'archive', name: '/folder', request_key: 'long-observation' });
  assert.equal(answer.item.due_at, null);
  const later = epoch + 5 * 86400000;
  answer = await finish(account, await account.call({ action: 'continue', id: answer.item.id }, later), later);
  assert.equal(answer.item.status, 'held');
  assert.equal(answer.item.created_at_ms, epoch);
  assert.equal(answer.item.entered_at_ms, later);
  assert.equal(Date.parse(answer.item.due_at), later + 30 * 86400000);
});

test('Native-filled task envelope supplies stable request and attested account actor, never caller authorship', async () => {
  const account = new Account(); account.add('/note');
  const task = { task_id: 'native-original', request_key: 'native-original', started_at: new Date(epoch).toISOString(), context: {
    account_id: 'native-account', admission: 'account', actor: { kind: 'account', id: 'native-account' },
  } };
  const input = { action: 'archive', name: '/note', by: 'caller label', actor: { kind: 'account', id: 'spoof' }, task: { context: { actor: { kind: 'person', id: 'spoof' } } } };
  const context = { door: account.door, admittedNames: account.names, now: epoch };
  const answer = await runTask({ input, task }, context);
  assert.deepEqual(answer.item.actor, { kind: 'account', id: 'native-account' });
  assert.equal(answer.item.by, 'native-account');
  assert.equal(answer.item.requested_by_label, 'caller label');
  assert.equal(answer.item.request.request_key, 'native-original');
  await runTask({ input, task }, context);
  assert.equal(account.saved.effects, 1);
});

test('Native withheld shared actor stays absent and disclosed actor stays a person', async () => {
  for (const actor of [undefined, { kind: 'person', id: 'disclosed-person' }]) {
    const account = new Account(); account.add('/note');
    const task = { task_id: 'shared-original', request_key: 'shared-original', started_at: new Date(epoch).toISOString(), context: {
      account_id: 'holder-account', admission: 'share_act', ...(actor ? { actor } : {}),
    } };
    const answer = await runTask({ input: { action: 'archive', name: '/note', by: 'not-attested' }, task }, { door: account.door, admittedNames: account.names, now: epoch });
    assert.deepEqual(answer.item.actor, actor ?? null);
    assert.equal(answer.item.by, actor?.id ?? null);
  }
});

test('malformed or missing Native task attestation refuses before effects or metadata', async () => {
  const account = new Account(); account.add('/note');
  const context = { door: account.door, admittedNames: account.names, now: epoch };
  await assert.rejects(runTask({ input: { action: 'archive', name: '/note', request_key: 'caller' } }, context), { code: 'native_task_unavailable' });
  await assert.rejects(runTask({ input: { action: 'archive', name: '/note' }, task: {
    task_id: 'native', request_key: 'native', started_at: new Date(epoch).toISOString(), context: { account_id: 'holder', admission: 'account', actor: { kind: 'account', id: 'another' } },
  } }, context), { code: 'native_context_invalid' });
  assert.equal(account.saved.writes, 0); assert.equal(account.saved.effects, 0);
});

test('production envelope uses Native task.started_at and refuses a missing clock', async () => {
  const account = new Account(); account.add('/note');
  const input = { action: 'archive', name: '/note' };
  const task = { task_id: 'clock', request_key: 'clock', started_at: new Date(epoch).toISOString() };
  const answer = await runTask({ input, task }, { door: account.door, admittedNames: account.names, now: epoch + 999999 });
  assert.equal(answer.item.created_at_ms, epoch);
  assert.equal(answer.item.entered_at_ms, epoch);
  await assert.rejects(runTask({ input, task: { task_id: 'clockless', request_key: 'clockless' } }, { door: account.door, admittedNames: account.names }), { code: 'native_clock_unavailable' });
});

test('same-scheduler cold scan persists only a bounded scalar position and resumes after lost output', async () => {
  let account = new Account();
  const ids = [];
  for (let index = 0; index < rules.cold_items * 2 + 1; index += 1) {
    const name = `/cold-${index}`; account.add(name);
    ids.push((await account.call({ action: 'archive', name, request_key: name })).item.id);
  }
  const seen = [];
  let scan;
  do {
    // Discarding wake_effects models a process stopping after saved metadata and
    // before stdout. The NEXT periodic firing starts from its saved scalar bound.
    scan = await account.call({ action: 'cold_sweep' }, epoch + 30 * 86400000);
    seen.push(...scan.inspected.map(item => item.id));
    assert.ok(scan.inspected.length <= rules.cold_items);
    assert.ok(scan.wake_effects.length <= rules.cold_items);
    account = account.restart();
  } while (scan.next_after);
  assert.deepEqual(seen, ids.sort().reverse());
  assert.equal(new Set(seen).size, ids.length);
  const kept = account.saved.records[`${rules.scan_type}|${rules.scan_id}`].value;
  assert.deepEqual(Object.keys(kept).sort(), ['after', 'schema']);
  // New cycle: the same existing periodic wake reaches deletion and forgets.
  do {
    scan = await account.call({ action: 'cold_sweep' }, epoch + 60 * 86400000);
  } while (scan.next_after);
  for (const id of ids) assert.equal((await account.call({ action: 'read', id })).item.status, 'forgotten');
});

test('interrupted cold scan consumer does not advance its persisted traversal position', async () => {
  const account = new Account(); account.add('/note');
  const held = await account.call({ action: 'archive', name: '/note', request_key: 'scan-stop' });
  const before = account.saved.records[`${rules.item_type}|${held.item.id}`];
  account.saved.records[`${rules.item_type}|${held.item.id}`] = { ...before, value: { ...before.value, schema: 'unsupported' } };
  await assert.rejects(account.call({ action: 'cold_sweep' }), { code: 'item_missing' });
  assert.equal(account.saved.records[`${rules.scan_type}|${rules.scan_id}`], undefined);
});

test('concrete Native folder marker protocol keeps frozen source fences and refreshes only created destination marker', async () => {
  const account = new Account(); account.keepEmptyFolders = true; account.folderProtocol = true; account.add('/folder/note');
  const sourceGeneration = account.saved.folders.live['/folder'];
  const answer = await account.call({ action: 'archive', name: '/folder', request_key: 'fenced-marker' });
  assert.equal(answer.item.status, 'held');
  assert.equal(account.saved.folders.live['/folder'], undefined);
  assert.ok(account.saved.folders.set_aside['/folder']);
  const command = Object.values(account.saved.receipts).find(row => row.original.input.folder);
  assert.equal(command.original.input.expected_generation, sourceGeneration);
  assert.notEqual(command.original.input.expected_destination_generation, 'folder:absent:0', 'the earlier file effect created this target marker');
  const restored = await account.call({ action: 'put_back', id: answer.item.id, request_key: 'restore-marker' });
  assert.equal(restored.item.status, 'restored');
  assert.equal(account.saved.folders.set_aside['/folder'], undefined);
  assert.equal(account.saved.live['/folder/note'].identity, identity);
});

test('fresh descendant refuses the frozen empty-folder cleanup and leaves a partial result', async () => {
  const account = new Account(); account.keepEmptyFolders = true; account.folderProtocol = true; account.add('/folder/note');
  const names = account.names, operation = names.operation;
  names.operation = async original => {
    if (original.input.folder) account.add('/folder/fresh');
    return operation(original);
  };
  const answer = await account.call({ action: 'archive', name: '/folder', request_key: 'fresh-descendant' }, epoch, { admittedNames: names });
  assert.equal(answer.item.status, 'partial');
  assert.ok(account.saved.folders.live['/folder']);
  assert.equal(account.saved.live['/folder/fresh'].identity, identity);
});

test('unactivated descriptor keeps the exact action schema and Native task envelope', () => {
  const row = descriptorCandidate.records[0].payload;
  assert.deepEqual(row.input_schema, inputSchema);
  assert.deepEqual(row.invoke.stdin, { input: { fill: { from: 'input' } }, task: { fill: { from: 'task' } } });
  assert.equal(row.wakes[0].input.action, 'cold_sweep');
  assert.equal(row.wakes[0].on.time.every_ms, 3600000);
  assert.match(descriptorCandidate.qualification, /UNACTIVATED/);
  assert.equal(row.invoke.records.rights.find(right => right.kind === 'setting').id, 'setting:keep_for');
  assert.deepEqual(row.invoke.records.rights.find(right => right.files).operations,
    ['name_command_observe', 'name_command_set_aside', 'name_command_put_back', 'name_command_forget_set_aside', 'name_command_result']);
  assert.ok(row.invoke.files.package_files[0].paths.includes('do-work/admitted-names.mjs'));
  assert.equal(row.invoke.records.rights.some(right => right.operations.includes('records:result')), false, 'Native result reads narrow through original write rights');
  assert.deepEqual(row.record_model.kinds.map(kind => kind.type).sort(), [rules.item_type, rules.page_type, rules.command_type, rules.scan_type].sort());
  assert.equal(row.record_model.kinds.some(kind => kind.type === 'setting'), false, 'Native own_part already declares setting with guard value:any');
  assert.ok(row.record_model.kinds.find(kind => kind.type === rules.page_type).erasable.includes('members'));
  assert.ok(row.record_model.kinds.every(kind => kind.stays_on_this_device === false), 'account metadata follows admitted account sync, not device placement');
});
